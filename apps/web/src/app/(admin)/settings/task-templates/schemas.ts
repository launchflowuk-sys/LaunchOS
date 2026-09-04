import { schema } from "@launchos/db";
import { z } from "zod";

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const TemplateSchema = z.object({
  /** "" means "every package"; the core service takes that as a null package_id. */
  packageId: z.union([z.literal(""), z.string().uuid()]),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  kind: z.enum(schema.taskKindEnum.enumValues),
  title: z.string().trim().min(1, "Title is required").max(200),
  descriptionMd: z.string().trim().max(10000),
  offsetDays: z.coerce.number().int().min(0).max(365),
  recurrence: z.enum(schema.taskRecurrenceEnum.enumValues),
  defaultAssigneeRole: z.enum(schema.taskAssigneeRoleEnum.enumValues),
  sortOrder: z.coerce.number().int().min(0).max(10000),
  /** One checklist item per line, so the order the operator typed is kept. */
  checklist: z
    .string()
    .max(4000)
    .transform((raw) => raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))
    .pipe(z.array(z.string().max(200)).max(50)),
});

export const TemplateIdSchema = z.object({ templateId: z.string().uuid() });

/** An empty number input posts ""; an absent select posts nothing at all. */
export function readTemplate(formData: FormData) {
  return {
    packageId: formData.get("packageId") ?? "",
    phase: formData.get("phase"),
    kind: formData.get("kind") ?? "other",
    title: formData.get("title"),
    descriptionMd: formData.get("descriptionMd") ?? "",
    offsetDays: formData.get("offsetDays") || 0,
    recurrence: formData.get("recurrence") ?? "none",
    defaultAssigneeRole: formData.get("defaultAssigneeRole") ?? "any",
    sortOrder: formData.get("sortOrder") || 0,
    checklist: formData.get("checklist") ?? "",
  };
}
