import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOrgMember, assertOwned } from "../tenancy/assert-owned.js";

export type TimeEntry = typeof schema.timeEntries.$inferSelect;

const Now = z.coerce.date().default(() => new Date());

export const ClockInInput = z.object({
  userId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  now: Now,
});
export type ClockInInput = z.input<typeof ClockInInput>;

export const ClockOutInput = z.object({ userId: z.string().min(1), now: Now });
export type ClockOutInput = z.input<typeof ClockOutInput>;

export const StartTimerInput = z
  .object({
    userId: z.string().min(1),
    taskId: z.string().uuid().optional(),
    ticketId: z.string().uuid().optional(),
    note: z.string().trim().max(500).optional(),
    now: Now,
  })
  .refine((v) => !(v.taskId && v.ticketId), { message: "a timer runs against a task or a case, not both" });
export type StartTimerInput = z.input<typeof StartTimerInput>;

export const GetRunningEntryInput = z.object({ userId: z.string().min(1) });
export type GetRunningEntryInput = z.input<typeof GetRunningEntryInput>;

/** The user's running entry, or null when they are clocked out. */
export async function getRunningEntry(db: Db, organisationId: string, input: GetRunningEntryInput): Promise<TimeEntry | null> {
  const v = GetRunningEntryInput.parse(input);
  const [row] = await db
    .select()
    .from(schema.timeEntries)
    .where(and(
      eq(schema.timeEntries.organisationId, organisationId),
      eq(schema.timeEntries.userId, v.userId),
      isNull(schema.timeEntries.endedAt),
    ))
    .limit(1);
  return row ?? null;
}

/** Closes the running entry, if any, and audits it. Shared by clock-out, stop-timer and the switch inside start-timer. */
async function closeRunning(db: Db, organisationId: string, userId: string, now: Date): Promise<TimeEntry | null> {
  const [closed] = await db
    .update(schema.timeEntries)
    .set({ endedAt: now, updatedAt: now })
    .where(and(
      eq(schema.timeEntries.organisationId, organisationId),
      eq(schema.timeEntries.userId, userId),
      isNull(schema.timeEntries.endedAt),
    ))
    .returning();
  if (!closed) return null;
  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: userId,
    action: "time_entry.stopped",
    targetType: "time_entry",
    targetId: closed.id,
    after: { id: closed.id, startedAt: closed.startedAt, endedAt: closed.endedAt, taskId: closed.taskId, ticketId: closed.ticketId },
  });
  return closed;
}

async function openEntry(
  db: Db,
  organisationId: string,
  v: { userId: string; taskId?: string | undefined; ticketId?: string | undefined; note?: string | undefined; now: Date },
): Promise<TimeEntry> {
  const [entry] = await db
    .insert(schema.timeEntries)
    .values({
      organisationId,
      userId: v.userId,
      startedAt: v.now,
      taskId: v.taskId ?? null,
      ticketId: v.ticketId ?? null,
      note: v.note ?? null,
    })
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: v.userId,
    action: "time_entry.started",
    targetType: "time_entry",
    targetId: entry!.id,
    after: { id: entry!.id, startedAt: entry!.startedAt, taskId: entry!.taskId, ticketId: entry!.ticketId, note: entry!.note },
  });
  return entry!;
}

/**
 * Starts the working day. One running entry per person: a second clock-in
 * while one is running returns that entry with `started: false` rather than
 * opening another, so a double-tap on the top-bar button is harmless.
 */
export async function clockIn(db: Db, organisationId: string, input: ClockInInput): Promise<{ entry: TimeEntry; started: boolean }> {
  const v = ClockInInput.parse(input);
  await assertOrgMember(db, organisationId, v.userId);
  const running = await getRunningEntry(db, organisationId, { userId: v.userId });
  if (running) return { entry: running, started: false };
  return { entry: await openEntry(db, organisationId, v), started: true };
}

/** Ends the running entry. Null when there was nothing running — not an error, the button was simply stale. */
export async function clockOut(db: Db, organisationId: string, input: ClockOutInput): Promise<TimeEntry | null> {
  const v = ClockOutInput.parse(input);
  await assertOrgMember(db, organisationId, v.userId);
  return closeRunning(db, organisationId, v.userId, v.now);
}

/**
 * Starts a timer against a task or a case. Whatever was running — a plain
 * clock-in, or a timer on something else — is closed first, so the person's
 * time is always in exactly one place. The closed entry comes back with the
 * new one so the page can say what it switched from.
 */
export async function startTimer(
  db: Db,
  organisationId: string,
  input: StartTimerInput,
): Promise<{ entry: TimeEntry; switchedFrom: TimeEntry | null }> {
  const v = StartTimerInput.parse(input);
  await assertOrgMember(db, organisationId, v.userId);
  if (v.taskId) await assertOwned(db, organisationId, schema.tasks, v.taskId);
  if (v.ticketId) await assertOwned(db, organisationId, schema.tickets, v.ticketId);
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const switchedFrom = await closeRunning(inner, organisationId, v.userId, v.now);
    const entry = await openEntry(inner, organisationId, v);
    return { entry, switchedFrom };
  });
}

/** Stops whatever is running. The same operation as clocking out; named for the task and case pages. */
export async function stopTimer(db: Db, organisationId: string, input: ClockOutInput): Promise<TimeEntry | null> {
  return clockOut(db, organisationId, input);
}
