import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { leadsAwaitingReply } from "../leads/leads.js";
import { FINISHED_STATUSES } from "../tasks/update-task-status.js";
import { entryMinutes } from "./week.js";

/** A Date inside a raw `sql` template: the driver will not bind a Date object, so it goes as ISO text and is cast back. */
const ts = (at: Date) => sql`${at.toISOString()}::timestamptz`;

const HOUR_MS = 3_600_000;

export const OpsMetricsInput = z.object({
  hours: z.number().int().min(1).max(24 * 14).default(24),
  now: z.coerce.date().default(() => new Date()),
});
export type OpsMetricsInput = z.input<typeof OpsMetricsInput>;

export interface MoneyCount { count: number; totalPence: number }

/**
 * The numbers the Ops Brief is allowed to quote. Everything here is read from
 * our own rows for one window; the agent may not state a figure that is not
 * in this object.
 */
export interface OpsMetricsSnapshot {
  window: { from: Date; to: Date; hours: number };
  cases: {
    /** Opened in the window. */
    opened: number;
    /** Resolved in the window. */
    resolved: number;
    open: number;
    /** Open and never answered. */
    awaitingFirstResponse: number;
    /** Open and past their SLA due time. */
    breachedSla: number;
    escalatedOpen: number;
    /** Median minutes to first reply over replies given in the window. Null with nothing to measure. */
    medianFirstResponseMinutes: number | null;
  };
  tasks: { open: number; overdue: number; completed: number };
  incidents: { open: number; opened: number; resolved: number };
  approvals: { pending: number; oldestPendingHours: number | null };
  invoices: { overdue: MoneyCount; outstanding: MoneyCount; paid: MoneyCount };
  content: { published: number; failed: number; awaitingApproval: number };
  agents: {
    runs: number;
    /** Runs that ended `failed` in the window — refusals, errors, stranded resumes. */
    failed: number;
    awaitingApproval: number;
  };
  team: {
    hoursClocked: number;
    clockedInNow: number;
    byMember: { userId: string; name: string; hours: number }[];
  };
  leads: {
    /** Still `new` — nobody has written back — after 24 hours. The brief's "waiting for a reply" line. */
    awaitingReplyOver24h: number;
  };
}

const count = sql<number>`count(*)::int`;
const pence = (column: unknown) => sql<number>`coalesce(sum(${column}), 0)::int`;

function roundedOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function caseMetrics(db: Db, org: string, from: Date, now: Date): Promise<OpsMetricsSnapshot["cases"]> {
  const t = schema.tickets;
  const isOpen = sql`${t.status} in ('open', 'triaged', 'in_progress', 'waiting_client')`;
  const [[windowed], [state], [answered]] = await Promise.all([
    db.select({
      opened: sql<number>`count(*) filter (where ${t.createdAt} >= ${ts(from)})::int`,
      resolved: sql<number>`count(*) filter (where ${t.resolvedAt} is not null and ${t.resolvedAt} >= ${ts(from)})::int`,
    }).from(t).where(eq(t.organisationId, org)),
    db.select({
      open: count,
      awaitingFirstResponse: sql<number>`count(*) filter (where ${t.firstResponseAt} is null)::int`,
      breachedSla: sql<number>`count(*) filter (where ${t.slaDueAt} is not null and ${t.slaDueAt} < ${ts(now)})::int`,
      escalatedOpen: sql<number>`count(*) filter (where ${t.escalated})::int`,
    }).from(t).where(and(eq(t.organisationId, org), isOpen)),
    db.select({
      median: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${t.firstResponseAt} - ${t.createdAt}))::double precision / 60)`,
    }).from(t).where(and(eq(t.organisationId, org), isNotNull(t.firstResponseAt), gte(t.firstResponseAt, from))),
  ]);
  return {
    opened: windowed?.opened ?? 0,
    resolved: windowed?.resolved ?? 0,
    open: state?.open ?? 0,
    awaitingFirstResponse: state?.awaitingFirstResponse ?? 0,
    breachedSla: state?.breachedSla ?? 0,
    escalatedOpen: state?.escalatedOpen ?? 0,
    medianFirstResponseMinutes: roundedOrNull(answered?.median),
  };
}

async function taskMetrics(db: Db, org: string, from: Date, now: Date): Promise<OpsMetricsSnapshot["tasks"]> {
  const t = schema.tasks;
  const [[live], [done]] = await Promise.all([
    db.select({
      open: count,
      overdue: sql<number>`count(*) filter (where ${t.dueAt} is not null and ${t.dueAt} < ${ts(now)})::int`,
    }).from(t).where(and(eq(t.organisationId, org), notInArray(t.status, [...FINISHED_STATUSES]))),
    db.select({ n: count }).from(t).where(and(eq(t.organisationId, org), isNotNull(t.completedAt), gte(t.completedAt, from))),
  ]);
  return { open: live?.open ?? 0, overdue: live?.overdue ?? 0, completed: done?.n ?? 0 };
}

async function incidentMetrics(db: Db, org: string, from: Date): Promise<OpsMetricsSnapshot["incidents"]> {
  const i = schema.incidents;
  const [row] = await db.select({
    open: sql<number>`count(*) filter (where ${i.status} <> 'resolved')::int`,
    opened: sql<number>`count(*) filter (where ${i.openedAt} >= ${ts(from)})::int`,
    resolved: sql<number>`count(*) filter (where ${i.resolvedAt} is not null and ${i.resolvedAt} >= ${ts(from)})::int`,
  }).from(i).where(eq(i.organisationId, org));
  return { open: row?.open ?? 0, opened: row?.opened ?? 0, resolved: row?.resolved ?? 0 };
}

async function approvalMetrics(db: Db, org: string, now: Date): Promise<OpsMetricsSnapshot["approvals"]> {
  const a = schema.approvals;
  const [row] = await db.select({
    pending: count,
    oldestHours: sql<number | null>`extract(epoch from (${ts(now)} - min(${a.createdAt})))::double precision / 3600`,
  }).from(a).where(and(eq(a.organisationId, org), eq(a.status, "pending")));
  const oldest = row?.oldestHours;
  return { pending: row?.pending ?? 0, oldestPendingHours: oldest === null || oldest === undefined ? null : Math.round(Number(oldest) * 10) / 10 };
}

async function invoiceMetrics(db: Db, org: string, from: Date): Promise<OpsMetricsSnapshot["invoices"]> {
  const inv = schema.invoices;
  const [[overdue], [outstanding], [paid]] = await Promise.all([
    db.select({ count, totalPence: pence(inv.totalPence) }).from(inv).where(and(eq(inv.organisationId, org), eq(inv.status, "overdue"))),
    db.select({ count, totalPence: pence(inv.totalPence) }).from(inv).where(and(eq(inv.organisationId, org), sql`${inv.status} in ('sent', 'overdue')`)),
    db.select({ count, totalPence: pence(inv.totalPence) }).from(inv).where(and(eq(inv.organisationId, org), eq(inv.status, "paid"), isNotNull(inv.paidAt), gte(inv.paidAt, from))),
  ]);
  const money = (row: { count: number; totalPence: number } | undefined): MoneyCount => ({ count: row?.count ?? 0, totalPence: row?.totalPence ?? 0 });
  return { overdue: money(overdue), outstanding: money(outstanding), paid: money(paid) };
}

async function contentMetrics(db: Db, org: string, from: Date): Promise<OpsMetricsSnapshot["content"]> {
  const c = schema.contentItems;
  const [row] = await db.select({
    published: sql<number>`count(*) filter (where ${c.publishedAt} is not null and ${c.publishedAt} >= ${ts(from)})::int`,
    failed: sql<number>`count(*) filter (where ${c.status} = 'failed' and ${c.updatedAt} >= ${ts(from)})::int`,
    awaitingApproval: sql<number>`count(*) filter (where ${c.status} = 'awaiting_approval')::int`,
  }).from(c).where(eq(c.organisationId, org));
  return { published: row?.published ?? 0, failed: row?.failed ?? 0, awaitingApproval: row?.awaitingApproval ?? 0 };
}

async function agentMetrics(db: Db, org: string, from: Date): Promise<OpsMetricsSnapshot["agents"]> {
  const r = schema.agentRuns;
  const [row] = await db.select({
    runs: sql<number>`count(*) filter (where ${r.startedAt} >= ${ts(from)})::int`,
    failed: sql<number>`count(*) filter (where ${r.status} = 'failed' and ${r.startedAt} >= ${ts(from)})::int`,
    awaitingApproval: sql<number>`count(*) filter (where ${r.status} = 'awaiting_approval')::int`,
  }).from(r).where(eq(r.organisationId, org));
  return { runs: row?.runs ?? 0, failed: row?.failed ?? 0, awaitingApproval: row?.awaitingApproval ?? 0 };
}

async function teamMetrics(db: Db, org: string, from: Date, now: Date): Promise<OpsMetricsSnapshot["team"]> {
  const e = schema.timeEntries;
  const rows = await db
    .select({ userId: e.userId, startedAt: e.startedAt, endedAt: e.endedAt, displayName: schema.organisationMembers.displayName, name: schema.user.name })
    .from(e)
    .innerJoin(schema.user, eq(schema.user.id, e.userId))
    .leftJoin(schema.organisationMembers, and(eq(schema.organisationMembers.userId, e.userId), eq(schema.organisationMembers.organisationId, e.organisationId)))
    .where(and(eq(e.organisationId, org), gte(e.startedAt, from), lt(e.startedAt, now)));
  const minutes = new Map<string, { name: string; minutes: number }>();
  let clockedInNow = 0;
  for (const row of rows) {
    if (row.endedAt === null) clockedInNow += 1;
    const current = minutes.get(row.userId) ?? { name: row.displayName ?? row.name, minutes: 0 };
    minutes.set(row.userId, { ...current, minutes: current.minutes + entryMinutes(row, now) });
  }
  const byMember = [...minutes.entries()].map(([userId, m]) => ({ userId, name: m.name, hours: Math.round((m.minutes / 60) * 10) / 10 }));
  const total = [...minutes.values()].reduce((sum, m) => sum + m.minutes, 0);
  return { hoursClocked: Math.round((total / 60) * 10) / 10, clockedInNow, byMember };
}

/** The whole snapshot for the window ending at `now`. Every section is read from our own rows. */
export async function opsMetricsSnapshot(db: Db, organisationId: string, input: OpsMetricsInput = {}): Promise<OpsMetricsSnapshot> {
  const v = OpsMetricsInput.parse(input);
  const from = new Date(v.now.getTime() - v.hours * HOUR_MS);
  const [cases, tasks, incidents, approvals, invoices, content, agents, team, waiting] = await Promise.all([
    caseMetrics(db, organisationId, from, v.now),
    taskMetrics(db, organisationId, from, v.now),
    incidentMetrics(db, organisationId, from),
    approvalMetrics(db, organisationId, v.now),
    invoiceMetrics(db, organisationId, from),
    contentMetrics(db, organisationId, from),
    agentMetrics(db, organisationId, from),
    teamMetrics(db, organisationId, from, v.now),
    leadsAwaitingReply(db, organisationId, { hours: 24, now: v.now, limit: 200 }),
  ]);
  return {
    window: { from, to: v.now, hours: v.hours },
    cases, tasks, incidents, approvals, invoices, content, agents, team,
    leads: { awaitingReplyOver24h: waiting.length },
  };
}
