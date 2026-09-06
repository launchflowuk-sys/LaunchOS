import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, gte, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { FINISHED_STATUSES } from "../tasks/update-task-status.js";
import { entryMinutes } from "./week.js";

/** A Date inside a raw `sql` template: the driver will not bind a Date object, so it goes as ISO text and is cast back. */
const ts = (at: Date) => sql`${at.toISOString()}::timestamptz`;

const DAY_MS = 86_400_000;

export const TeamHealthInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
  now: z.coerce.date().default(() => new Date()),
});
export type TeamHealthInput = z.input<typeof TeamHealthInput>;

export interface MemberHealth {
  userId: string;
  name: string;
  role: "owner" | "staff";
  /** Cases assigned to them that were opened in the window. */
  casesAssigned: number;
  /** Cases assigned to them that were resolved in the window. */
  casesResolved: number;
  /** Median minutes from a case opening to their first reply, over replies given in the window. Null with nothing to measure. */
  medianFirstResponseMinutes: number | null;
  /** Their tasks past due right now. */
  overdueTasks: number;
  /** Hours clocked in the window, to one decimal. */
  hoursClocked: number;
}

export interface TeamHealth {
  window: { from: Date; to: Date; days: number };
  members: MemberHealth[];
  organisation: {
    medianFirstResponseMinutes: number | null;
    /** Cases first answered in the window; the sample the median is over. */
    casesAnswered: number;
    openCases: number;
    openTasks: number;
    overdueTasks: number;
    openIncidents: number;
  };
}

/** Statuses a case is still live in. Mirrors the ticket lifecycle; `resolved` and `closed` are done. */
export const OPEN_TICKET_STATUSES = ["open", "triaged", "in_progress", "waiting_client"] as const;

/**
 * `percentile_cont` over minutes-to-first-reply. `extract(epoch …)` is
 * `numeric` since Postgres 14 and would come back as a string; the cast makes
 * it a double the driver parses.
 */
const firstResponseMinutes = sql`extract(epoch from (${schema.tickets.firstResponseAt} - ${schema.tickets.createdAt}))::double precision / 60`;
const medianMinutes = sql<number | null>`percentile_cont(0.5) within group (order by ${firstResponseMinutes})`;

function roundedOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function countsByAssignee(db: Db, organisationId: string, from: Date) {
  const assignee = schema.tickets.assignedUserId;
  const base = and(eq(schema.tickets.organisationId, organisationId), isNotNull(assignee));
  const [assigned, resolved, answered] = await Promise.all([
    db.select({ userId: assignee, n: sql<number>`count(*)::int` }).from(schema.tickets)
      .where(and(base, gte(schema.tickets.createdAt, from))).groupBy(assignee),
    db.select({ userId: assignee, n: sql<number>`count(*)::int` }).from(schema.tickets)
      .where(and(base, isNotNull(schema.tickets.resolvedAt), gte(schema.tickets.resolvedAt, from))).groupBy(assignee),
    db.select({ userId: assignee, median: medianMinutes }).from(schema.tickets)
      .where(and(base, isNotNull(schema.tickets.firstResponseAt), gte(schema.tickets.firstResponseAt, from))).groupBy(assignee),
  ]);
  const by = <T extends { userId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.userId!, r]));
  return { assigned: by(assigned), resolved: by(resolved), answered: by(answered) };
}

async function overdueTasksByAssignee(db: Db, organisationId: string, now: Date) {
  const rows = await db
    .select({ userId: schema.tasks.assigneeUserId, n: sql<number>`count(*)::int` })
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.organisationId, organisationId),
      isNotNull(schema.tasks.assigneeUserId),
      isNotNull(schema.tasks.dueAt),
      lt(schema.tasks.dueAt, now),
      notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
    ))
    .groupBy(schema.tasks.assigneeUserId);
  return new Map(rows.map((r) => [r.userId!, r.n]));
}

/** Minutes clocked per user in [from, now): entries that started in the window, running ones counted to now. */
async function minutesByUser(db: Db, organisationId: string, from: Date, now: Date) {
  const rows = await db
    .select({ userId: schema.timeEntries.userId, startedAt: schema.timeEntries.startedAt, endedAt: schema.timeEntries.endedAt })
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.organisationId, organisationId), gte(schema.timeEntries.startedAt, from), lt(schema.timeEntries.startedAt, now)));
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.userId, (totals.get(row.userId) ?? 0) + entryMinutes(row, now));
  return totals;
}

async function organisationLine(db: Db, organisationId: string, from: Date, now: Date): Promise<TeamHealth["organisation"]> {
  const [[answered], [cases], [tasks], [incidents]] = await Promise.all([
    db.select({ median: medianMinutes, n: sql<number>`count(*)::int` }).from(schema.tickets)
      .where(and(eq(schema.tickets.organisationId, organisationId), isNotNull(schema.tickets.firstResponseAt), gte(schema.tickets.firstResponseAt, from))),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.tickets)
      .where(and(eq(schema.tickets.organisationId, organisationId), sql`${schema.tickets.status} in ('open', 'triaged', 'in_progress', 'waiting_client')`)),
    db.select({
      open: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${schema.tasks.dueAt} is not null and ${schema.tasks.dueAt} < ${ts(now)})::int`,
    }).from(schema.tasks)
      .where(and(eq(schema.tasks.organisationId, organisationId), notInArray(schema.tasks.status, [...FINISHED_STATUSES]))),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.incidents)
      .where(and(eq(schema.incidents.organisationId, organisationId), sql`${schema.incidents.status} <> 'resolved'`)),
  ]);
  return {
    medianFirstResponseMinutes: roundedOrNull(answered?.median ?? null),
    casesAnswered: answered?.n ?? 0,
    openCases: cases?.n ?? 0,
    openTasks: tasks?.open ?? 0,
    overdueTasks: tasks?.overdue ?? 0,
    openIncidents: incidents?.n ?? 0,
  };
}

/**
 * How the team is doing over the last `days`: per active member, the cases
 * they were given and closed, how quickly they first answered, what they are
 * late on and the hours they clocked; and the organisation's own line, which
 * is what the SLA promise in the acknowledgement email is measured against.
 */
export async function teamHealth(db: Db, organisationId: string, input: TeamHealthInput = {}): Promise<TeamHealth> {
  const v = TeamHealthInput.parse(input);
  const from = new Date(v.now.getTime() - v.days * DAY_MS);

  const [members, counts, overdue, minutes, organisation] = await Promise.all([
    db.select({
      userId: schema.organisationMembers.userId,
      displayName: schema.organisationMembers.displayName,
      name: schema.user.name,
      role: schema.organisationMembers.role,
    })
      .from(schema.organisationMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.organisationMembers.userId))
      .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.status, "active")))
      // Joined-date order, then name — the same tie-break `teamTimesheets`
      // needs and for the same reason: members added in one transaction share
      // `now()` to the microsecond, so without it Postgres may return them in
      // any order and the team list reshuffles between page loads.
      .orderBy(asc(schema.organisationMembers.createdAt), asc(schema.user.name)),
    countsByAssignee(db, organisationId, from),
    overdueTasksByAssignee(db, organisationId, v.now),
    minutesByUser(db, organisationId, from, v.now),
    organisationLine(db, organisationId, from, v.now),
  ]);

  return {
    window: { from, to: v.now, days: v.days },
    members: members.map((m) => ({
      userId: m.userId,
      name: m.displayName ?? m.name,
      role: m.role,
      casesAssigned: counts.assigned.get(m.userId)?.n ?? 0,
      casesResolved: counts.resolved.get(m.userId)?.n ?? 0,
      medianFirstResponseMinutes: roundedOrNull(counts.answered.get(m.userId)?.median ?? null),
      overdueTasks: overdue.get(m.userId) ?? 0,
      hoursClocked: Math.round(((minutes.get(m.userId) ?? 0) / 60) * 10) / 10,
    })),
    organisation,
  };
}
