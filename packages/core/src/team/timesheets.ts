import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import type { TimeEntry } from "./time-entries.js";
import { entryMinutes, londonDayOf, weekBounds, type IsoDate, type WeekBounds } from "./week.js";

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD date");
const Now = z.coerce.date().default(() => new Date());

export const ListTimesheetInput = z.object({ userId: z.string().min(1), weekStart: IsoDay, now: Now });
export type ListTimesheetInput = z.input<typeof ListTimesheetInput>;

export interface TimesheetEntry {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  minutes: number;
  running: boolean;
  taskId: string | null;
  taskTitle: string | null;
  ticketId: string | null;
  ticketSubject: string | null;
  note: string | null;
}

export interface TimesheetDay {
  date: IsoDate;
  minutes: number;
  entries: TimesheetEntry[];
}

export interface Timesheet {
  userId: string;
  weekStart: IsoDate;
  weekEnd: IsoDate;
  days: TimesheetDay[];
  totalMinutes: number;
}

type EntryWithLinks = TimeEntry & { taskTitle: string | null; ticketSubject: string | null };

/** Every entry that started inside the week, for one user or the whole organisation, oldest first. */
async function entriesInWeek(db: Db, organisationId: string, week: WeekBounds, userId?: string): Promise<EntryWithLinks[]> {
  const rows = await db
    .select({
      entry: schema.timeEntries,
      taskTitle: schema.tasks.title,
      ticketSubject: schema.tickets.subject,
    })
    .from(schema.timeEntries)
    .leftJoin(schema.tasks, eq(schema.tasks.id, schema.timeEntries.taskId))
    .leftJoin(schema.tickets, eq(schema.tickets.id, schema.timeEntries.ticketId))
    .where(and(
      eq(schema.timeEntries.organisationId, organisationId),
      userId ? eq(schema.timeEntries.userId, userId) : undefined,
      gte(schema.timeEntries.startedAt, week.start),
      lt(schema.timeEntries.startedAt, week.end),
    ))
    .orderBy(asc(schema.timeEntries.startedAt));
  return rows.map((r) => ({ ...r.entry, taskTitle: r.taskTitle, ticketSubject: r.ticketSubject }));
}

function toTimesheetEntry(entry: EntryWithLinks, now: Date): TimesheetEntry {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    minutes: entryMinutes(entry, now),
    running: entry.endedAt === null,
    taskId: entry.taskId,
    taskTitle: entry.taskTitle,
    ticketId: entry.ticketId,
    ticketSubject: entry.ticketSubject,
    note: entry.note,
  };
}

/** Groups entries by the London day they started on, one bucket per day of the week even when empty. */
function bucketByDay(week: WeekBounds, entries: EntryWithLinks[], now: Date): TimesheetDay[] {
  const byDay = new Map<IsoDate, TimesheetEntry[]>(week.days.map((d) => [d, []]));
  for (const entry of entries) {
    const bucket = byDay.get(londonDayOf(entry.startedAt));
    if (bucket) bucket.push(toTimesheetEntry(entry, now));
  }
  return week.days.map((date) => {
    const dayEntries = byDay.get(date)!;
    return { date, entries: dayEntries, minutes: dayEntries.reduce((sum, e) => sum + e.minutes, 0) };
  });
}

/**
 * One person's week: seven days, Monday first, each with its entries and
 * minutes, plus the week total. An entry is counted on the London day it
 * started, and a running one is counted up to `now`. `weekStart` may be any
 * day of the week; it snaps to the Monday.
 */
export async function listTimesheet(db: Db, organisationId: string, input: ListTimesheetInput): Promise<Timesheet> {
  const v = ListTimesheetInput.parse(input);
  const week = weekBounds(v.weekStart);
  const entries = await entriesInWeek(db, organisationId, week, v.userId);
  const days = bucketByDay(week, entries, v.now);
  return {
    userId: v.userId,
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    days,
    totalMinutes: days.reduce((sum, d) => sum + d.minutes, 0),
  };
}

export const TeamTimesheetsInput = z.object({ weekStart: IsoDay, now: Now });
export type TeamTimesheetsInput = z.input<typeof TeamTimesheetsInput>;

export interface MemberTimesheet {
  userId: string;
  name: string;
  role: "owner" | "staff";
  /** Minutes per day, Monday first. */
  dayMinutes: number[];
  totalMinutes: number;
  /** True while the member has an entry running right now. */
  running: boolean;
}

export interface TeamTimesheets {
  weekStart: IsoDate;
  weekEnd: IsoDate;
  days: IsoDate[];
  members: MemberTimesheet[];
  totalMinutes: number;
}

/**
 * The whole active team's week at a glance: per member, minutes per day and
 * the total. Members are listed even with nothing logged, so a blank row is
 * visible rather than missing.
 */
export async function teamTimesheets(db: Db, organisationId: string, input: TeamTimesheetsInput): Promise<TeamTimesheets> {
  const v = TeamTimesheetsInput.parse(input);
  const week = weekBounds(v.weekStart);
  const [members, entries] = await Promise.all([
    db
      .select({
        userId: schema.organisationMembers.userId,
        displayName: schema.organisationMembers.displayName,
        name: schema.user.name,
        role: schema.organisationMembers.role,
      })
      .from(schema.organisationMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.organisationMembers.userId))
      .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.status, "active")))
      .orderBy(asc(schema.organisationMembers.createdAt)),
    entriesInWeek(db, organisationId, week),
  ]);

  const rows = members.map((member): MemberTimesheet => {
    const own = entries.filter((e) => e.userId === member.userId);
    const days = bucketByDay(week, own, v.now);
    return {
      userId: member.userId,
      name: member.displayName ?? member.name,
      role: member.role,
      dayMinutes: days.map((d) => d.minutes),
      totalMinutes: days.reduce((sum, d) => sum + d.minutes, 0),
      running: own.some((e) => e.endedAt === null),
    };
  });

  return {
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    days: week.days,
    members: rows,
    totalMinutes: rows.reduce((sum, m) => sum + m.totalMinutes, 0),
  };
}
