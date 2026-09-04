import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, isNotNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import { emit } from "../events/emit.js";
import { notify, notifyOwner } from "../notifications/notify.js";
import { londonDateKey } from "./dates.js";
import { FINISHED_STATUSES } from "./update-task-status.js";

export const OverdueInput = z.object({ now: z.coerce.date().default(() => new Date()) });
export type OverdueInput = z.input<typeof OverdueInput>;

export async function findOverdueTasks(db: Db, organisationId: string, input: OverdueInput = {}) {
  const { now } = OverdueInput.parse(input);
  return db.select().from(schema.tasks).where(and(
    eq(schema.tasks.organisationId, organisationId),
    isNotNull(schema.tasks.dueAt),
    lt(schema.tasks.dueAt, now),
    notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
  )).orderBy(asc(schema.tasks.dueAt));
}

/**
 * The daily 08:00 chase. `metadata.lastOverdueNotifiedOn` holds the London
 * date of the last nudge, so a task that stays late produces one notification
 * a day rather than one per sweep — and re-running the cron after a restart is
 * free.
 */
export async function notifyOverdueTasks(db: Db, organisationId: string, input: OverdueInput = {}) {
  const { now } = OverdueInput.parse(input);
  const today = londonDateKey(now);
  const overdue = await findOverdueTasks(db, organisationId, { now });
  let notified = 0;

  for (const task of overdue) {
    const metadata = task.metadata as { lastOverdueNotifiedOn?: string };
    if (metadata.lastOverdueNotifiedOn === today) continue;

    const link = `/tasks/${task.id}`;
    const title = `Task overdue: ${task.title}`;
    const body = task.dueAt ? `Due ${londonDateKey(task.dueAt)}` : undefined;

    await notifyOwner(db, organisationId, { kind: "task.overdue", title, body, link });
    if (task.assigneeUserId) {
      await notify(db, organisationId, { userId: task.assigneeUserId, kind: "task.overdue", title, body, link });
    }

    await db.update(schema.tasks)
      .set({ metadata: { ...metadata, lastOverdueNotifiedOn: today }, updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.organisationId, organisationId)));

    await emit({ name: "task.overdue", organisationId, taskId: task.id });
    notified += 1;
  }

  return { overdue: overdue.length, notified };
}
