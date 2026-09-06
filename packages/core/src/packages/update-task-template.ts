import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { TaskTemplateEvidenceInput } from "../tasks/evidence.js";

const Actor = { actorKind: z.enum(["user", "client", "agent", "system"]).default("user"), actorId: z.string().optional() };

/**
 * Every field optional and — unlike `TaskTemplateFields.partial()` — with no
 * defaults: in Zod 4 an optional field still applies its default, so a
 * partial update that omitted `kind` would have reset it to `other`, and one
 * that omitted `evidence` would have wiped the proof rule. Omitted means
 * "leave it alone" here.
 */
export const UpdateTaskTemplateInput = z.object({
  packageId: z.string().uuid().nullish(),
  phase: z.enum(schema.taskPhaseEnum.enumValues).optional(),
  kind: z.enum(schema.taskKindEnum.enumValues).optional(),
  title: z.string().min(1).max(200).optional(),
  descriptionMd: z.string().max(10000).nullish(),
  offsetDays: z.number().int().min(0).max(365).optional(),
  recurrence: z.enum(schema.taskRecurrenceEnum.enumValues).optional(),
  defaultAssigneeRole: z.enum(schema.taskAssigneeRoleEnum.enumValues).optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  checklist: z.array(z.string().min(1).max(200)).max(50).optional(),
  evidence: TaskTemplateEvidenceInput.optional(),
  templateId: z.string().uuid(),
  ...Actor,
});
export type UpdateTaskTemplateInput = z.input<typeof UpdateTaskTemplateInput>;

export async function updateTaskTemplate(db: Db, organisationId: string, input: UpdateTaskTemplateInput) {
  const v = UpdateTaskTemplateInput.parse(input);
  const where = and(eq(schema.taskTemplates.id, v.templateId), eq(schema.taskTemplates.organisationId, organisationId));
  const [before] = await db.select().from(schema.taskTemplates).where(where);
  if (!before) throw new Error(`task template ${v.templateId} not found in organisation`);
  if (v.packageId) await assertOwned(db, organisationId, schema.packages, v.packageId);

  const [after] = await db.update(schema.taskTemplates).set({
    ...(v.packageId === undefined ? {} : { packageId: v.packageId ?? null }),
    ...(v.phase === undefined ? {} : { phase: v.phase }),
    ...(v.kind === undefined ? {} : { kind: v.kind }),
    ...(v.title === undefined ? {} : { title: v.title }),
    ...(v.descriptionMd === undefined ? {} : { descriptionMd: v.descriptionMd ?? null }),
    ...(v.offsetDays === undefined ? {} : { offsetDays: v.offsetDays }),
    ...(v.recurrence === undefined ? {} : { recurrence: v.recurrence }),
    ...(v.defaultAssigneeRole === undefined ? {} : { defaultAssigneeRole: v.defaultAssigneeRole }),
    ...(v.sortOrder === undefined ? {} : { sortOrder: v.sortOrder }),
    ...(v.checklist === undefined ? {} : { checklist: v.checklist }),
    ...(v.evidence === undefined ? {} : { evidence: v.evidence }),
    updatedAt: new Date(),
  }).where(where).returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task_template.updated",
    targetType: "task_template", targetId: v.templateId, before, after,
  });
  return after!;
}

export const DeleteTaskTemplateInput = z.object({ templateId: z.string().uuid(), ...Actor });
export type DeleteTaskTemplateInput = z.input<typeof DeleteTaskTemplateInput>;

/**
 * Hard delete. `tasks.template_id` is ON DELETE SET NULL, so tasks already
 * generated from the template survive; they simply stop counting towards the
 * (client, template) idempotency key, which is correct — the blueprint is gone.
 */
export async function deleteTaskTemplate(db: Db, organisationId: string, input: DeleteTaskTemplateInput) {
  const v = DeleteTaskTemplateInput.parse(input);
  const where = and(eq(schema.taskTemplates.id, v.templateId), eq(schema.taskTemplates.organisationId, organisationId));
  const [before] = await db.select().from(schema.taskTemplates).where(where);
  if (!before) return { deleted: false };
  await db.delete(schema.taskTemplates).where(where);
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task_template.deleted",
    targetType: "task_template", targetId: v.templateId, before,
  });
  return { deleted: true };
}
