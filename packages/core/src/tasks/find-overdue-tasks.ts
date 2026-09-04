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
 *
 * Each task's two notification inserts and its metadata stamp commit as one
 * transaction, so a failure partway never leaves a task half-notified; the
 * event emits only after that commit. A deactivated assignee (removed from
 * the organisation) makes `notify` throw — that is swallowed so the task
 * still gets its owner notification and its stamp, rather than losing the
 * whole task. Each task is further isolated with its own try/catch so any
 * other unexpected failure skips just that task — it stays un-notified today
 * and is picked up again on the next sweep — instead of aborting the run.
 */
export async function notifyOverdueTasks(db: Db, organisationId: string, input: OverdueInput = {}) {
  const { now } = OverdueInput.parse(input);
  const today = londonDateKey(now);
  const overdue = await findOverdueTasks(db, organisationId, { now });
  let notified = 0;

  for (const task of overdue) {
    const metadata = task.metadata as { lastOverdueNotifiedOn?: string };
    if (metadata.lastOverdueNotifiedOn === today) continue;

    try {
      const link = `/tasks/${task.id}`;
      const title = `Task overdue: ${task.title}`;
      const body = task.dueAt ? `Due ${londonDateKey(task.dueAt)}` : undefined;

      await db.transaction(async (tx) => {
        await notifyOwner(tx as unknown as Db, organisationId, { kind: "task.overdue", title, body, link });

        if (task.assigneeUserId) {
          try {
            await notify(tx as unknown as Db, organisationId, { userId: task.assigneeUserId, kind: "task.overdue", title, body, link });
          } catch {
            // Assignee is no longer an active member — chase the owner only
            // rather than losing the notification (and the stamp below) for
            // this task entirely.
          }
        }

        await tx.update(schema.tasks)
          .set({ metadata: { ...metadata, lastOverdueNotifiedOn: today }, updatedAt: new Date() })
          .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.organisationId, organisationId)));
      });

      await emit({ name: "task.overdue", organisationId, taskId: task.id });
      notified += 1;
    } catch {
      // Leave this task un-notified today; the next sweep retries it. One
      // task's failure must not stop the chase for the rest.
    }
  }

  return { overdue: overdue.length, notified };
}
