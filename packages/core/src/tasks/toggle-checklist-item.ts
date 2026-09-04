import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const ToggleChecklistItemInput = z.object({
  taskId: z.string().uuid(),
  index: z.number().int().min(0).max(49),
  done: z.boolean(),
});
export type ToggleChecklistItemInput = z.infer<typeof ToggleChecklistItemInput>;

export async function toggleChecklistItem(db: Db, organisationId: string, input: ToggleChecklistItemInput) {
  const v = ToggleChecklistItemInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);
  if (v.index >= before.checklist.length) throw new Error(`checklist index ${v.index} is out of range`);

  // New array, new items — the loaded row is never mutated.
  const checklist = before.checklist.map((item, i) => (i === v.index ? { ...item, done: v.done } : item));

  return db.transaction(async (tx) => {
    const [after] = await tx.update(schema.tasks).set({ checklist, updatedAt: new Date() }).where(where).returning();
    // No actor travels through this input (see ToggleChecklistItemInput) —
    // "system" matches the default other task writes fall back to when the
    // caller doesn't carry one.
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "system", action: "task.checklist_toggled",
      targetType: "task", targetId: v.taskId, before, after,
    });
    return after!;
  });
}

export const SetTaskVisibilityInput = z.object({
  taskId: z.string().uuid(),
  clientVisible: z.boolean(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type SetTaskVisibilityInput = z.input<typeof SetTaskVisibilityInput>;

/** Whether this task appears in the client portal's task list (P4 renders it). */
export async function setTaskVisibility(db: Db, organisationId: string, input: SetTaskVisibilityInput) {
  const v = SetTaskVisibilityInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);

  return db.transaction(async (tx) => {
    const [after] = await tx.update(schema.tasks)
      .set({ clientVisible: v.clientVisible, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "task.visibility_changed",
      targetType: "task", targetId: v.taskId, before, after,
    });
    return after!;
  });
}
