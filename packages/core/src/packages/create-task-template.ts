import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { TaskTemplateEvidenceInput } from "../tasks/evidence.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const TaskTemplateFields = z.object({
  packageId: z.string().uuid().nullish(),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  kind: z.enum(schema.taskKindEnum.enumValues).default("other"),
  title: z.string().min(1).max(200),
  descriptionMd: z.string().max(10000).nullish(),
  offsetDays: z.number().int().min(0).max(365).default(0),
  recurrence: z.enum(schema.taskRecurrenceEnum.enumValues).default("none"),
  defaultAssigneeRole: z.enum(schema.taskAssigneeRoleEnum.enumValues).default("any"),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  checklist: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Proof of work a task made from this template must carry before it can close. */
  evidence: TaskTemplateEvidenceInput.default({ required: false, kinds: [], checklist: [] }),
});

export const CreateTaskTemplateInput = TaskTemplateFields.extend({
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type CreateTaskTemplateInput = z.input<typeof CreateTaskTemplateInput>;

export async function createTaskTemplate(db: Db, organisationId: string, input: CreateTaskTemplateInput) {
  const v = CreateTaskTemplateInput.parse(input);
  if (v.packageId) await assertOwned(db, organisationId, schema.packages, v.packageId);
  const [template] = await db.insert(schema.taskTemplates).values({
    organisationId, packageId: v.packageId ?? null, phase: v.phase, kind: v.kind, title: v.title,
    descriptionMd: v.descriptionMd ?? null, offsetDays: v.offsetDays, recurrence: v.recurrence,
    defaultAssigneeRole: v.defaultAssigneeRole, sortOrder: v.sortOrder, checklist: v.checklist, evidence: v.evidence,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "task_template.created",
    targetType: "task_template", targetId: template!.id, after: template,
  });
  return template!;
}
