import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";

/** Statuses that mean "no longer on anybody's plate". */
export const FINISHED_STATUSES = ["done", "cancelled"] as const;

export const UpdateTaskStatusInput = z.object({
  taskId: z.string().uuid(),
  status: z.enum(schema.taskStatusEnum.enumValues),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type UpdateTaskStatusInput = z.input<typeof UpdateTaskStatusInput>;

export async function updateTaskStatus(db: Db, organisationId: string, input: UpdateTaskStatusInput) {
  const v = UpdateTaskStatusInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);

  const result = await db.transaction(async (tx) => {
    const [task] = await tx.update(schema.tasks).set({
      status: v.status,
      // Keep the original completion time when a done task is re-saved as done.
      completedAt: v.status === "done" ? before.completedAt ?? new Date() : null,
      updatedAt: new Date(),
    }).where(where).returning();

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "task.status_changed",
      targetType: "task", targetId: v.taskId, before, after: task,
    });
    await recordActivity(tx as unknown as Db, organisationId, {
      clientId: task!.clientId, siteId: task!.siteId ?? undefined,
      actorKind: v.actorKind, actorId: v.actorId, kind: "task.status_changed",
      title: `${task!.title}: ${before.status} to ${v.status}`, link: `/tasks/${task!.id}`,
    });

    let handoverRecorded = false;
    let onboardingCompleted = false;

    if (v.status === "done" && task!.kind === "handover") {
      const [c] = await tx.update(schema.clients)
        .set({ handoverAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.clients.id, task!.clientId),
          eq(schema.clients.organisationId, organisationId),
          isNull(schema.clients.handoverAt),
        ))
        .returning();
      handoverRecorded = Boolean(c);
    }

    if (v.status === "done" && task!.phase === "onboarding") {
      const [outstanding] = await tx.select({ value: count() }).from(schema.tasks).where(and(
        eq(schema.tasks.organisationId, organisationId),
        eq(schema.tasks.clientId, task!.clientId),
        eq(schema.tasks.phase, "onboarding"),
        notInArray(schema.tasks.status, [...FINISHED_STATUSES]),
      ));
      if ((outstanding?.value ?? 0) === 0) {
        const [c] = await tx.update(schema.clients)
          .set({ onboardedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(schema.clients.id, task!.clientId),
            eq(schema.clients.organisationId, organisationId),
            isNull(schema.clients.onboardedAt),
          ))
          .returning();
        onboardingCompleted = Boolean(c);
      }
    }

    return { task: task!, onboardingCompleted, handoverRecorded };
  });

  if (v.status === "done") await emit({ name: "task.completed", organisationId, taskId: result.task.id });
  return result;
}
