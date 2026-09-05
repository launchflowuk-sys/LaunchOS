import { entryMinutes, getRunningEntry } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { AdminSession } from "@/lib/session";

/**
 * The entry the signed-in member is clocked on right now, as the shell and
 * the timer buttons need it: plain data (a Date crosses to a client component
 * as a string, so it is one already) plus the title of whatever it is timing.
 */
export type RunningEntry = {
  id: string;
  startedAt: string;
  /** Whole minutes so far, computed here so the first paint needs no clock. */
  minutes: number;
  taskId: string | null;
  ticketId: string | null;
  /** The task title or case subject being timed; null for a plain clock-in. */
  label: string | null;
};

export async function runningEntryFor(session: AdminSession): Promise<RunningEntry | null> {
  const db = getDb();
  const entry = await getRunningEntry(db, session.organisationId, { userId: session.userId });
  if (!entry) return null;
  return {
    id: entry.id,
    startedAt: entry.startedAt.toISOString(),
    minutes: entryMinutes(entry, new Date()),
    taskId: entry.taskId,
    ticketId: entry.ticketId,
    label: await linkedLabel(session.organisationId, entry.taskId, entry.ticketId),
  };
}

/** What a timer is against, by name — for the top bar and the "stopped timing X" toast. */
export async function linkedLabel(
  organisationId: string,
  taskId: string | null,
  ticketId: string | null,
): Promise<string | null> {
  const db = getDb();
  if (taskId) {
    const [task] = await db
      .select({ title: schema.tasks.title })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.organisationId, organisationId)));
    return task?.title ?? null;
  }
  if (ticketId) {
    const [ticket] = await db
      .select({ subject: schema.tickets.subject })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.organisationId, organisationId)));
    return ticket?.subject ?? null;
  }
  return null;
}
