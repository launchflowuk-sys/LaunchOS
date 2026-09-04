import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notify } from "../notifications/notify.js";
import { assertOrgMember } from "../tenancy/assert-owned.js";

export const AssignTaskInput = z.object({
  taskId: z.string().uuid(),
  assigneeUserId: z.string().min(1).nullable(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type AssignTaskInput = z.input<typeof AssignTaskInput>;

export async function assignTask(db: Db, organisationId: string, input: AssignTaskInput) {
  const v = AssignTaskInput.parse(input);
  const where = and(eq(schema.tasks.id, v.taskId), eq(schema.tasks.organisationId, organisationId));
  const [before] = await db.select().from(schema.tasks).where(where);
  if (!before) throw new Error(`task ${v.taskId} not found in organisation`);

  if (v.assigneeUserId) {
    try {
      await assertOrgMember(db, organisationId, v.assigneeUserId);
    } catch {
      throw new Error(`user ${v.assigneeUserId} is not an active member of this organisation`);
    }
  }

  const [after] = await db.update(schema.tasks)
    .set({ assigneeUserId: v.assigneeUserId, updatedAt: new Date() })
    .where(where).returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task.assigned",
    targetType: "task", targetId: v.taskId, before, after,
  });
  await recordActivity(db, organisationId, {
    clientId: after!.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "task.assigned",
    title: v.assigneeUserId ? `${after!.title} assigned` : `${after!.title} unassigned`,
    link: `/tasks/${v.taskId}`,
  });

  // Let the new owner of the work know without waiting for them to notice it
  // in a list. Unassigning is quiet — nobody needs a "you no longer own this".
  if (v.assigneeUserId) {
    await notify(db, organisationId, {
      userId: v.assigneeUserId,
      kind: "task.assigned",
      title: `Assigned: ${after!.title}`,
      link: `/tasks/${v.taskId}`,
    });
  }

  return after!;
}
