"use server";

import { createTaskTemplate, deleteTaskTemplate, updateTaskTemplate } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { type ActionResult, readTemplate, TemplateIdSchema, TemplateSchema } from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

function revalidate() {
  revalidatePath("/settings/task-templates");
}

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function createTemplateAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = TemplateSchema.safeParse(readTemplate(formData));
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid template" };
  const v = parsed.data;

  try {
    const template = await createTaskTemplate(getDb(), session.organisationId, {
      ...v,
      packageId: v.packageId.length > 0 ? v.packageId : null,
      descriptionMd: v.descriptionMd.length > 0 ? v.descriptionMd : null,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidate();
    return { status: "ok", id: template.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function updateTemplateAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const id = TemplateIdSchema.safeParse({ templateId: formData.get("templateId") });
  if (!id.success) return { status: "error", message: "That template could not be identified" };
  const parsed = TemplateSchema.safeParse(readTemplate(formData));
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid template" };
  const v = parsed.data;

  try {
    const template = await updateTaskTemplate(getDb(), session.organisationId, {
      templateId: id.data.templateId,
      ...v,
      packageId: v.packageId.length > 0 ? v.packageId : null,
      descriptionMd: v.descriptionMd.length > 0 ? v.descriptionMd : null,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidate();
    return { status: "ok", id: template.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Hard delete. `tasks.template_id` is ON DELETE SET NULL, so tasks already
 * generated from this blueprint survive it.
 */
export async function deleteTemplateAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const id = TemplateIdSchema.safeParse({ templateId: formData.get("templateId") });
  if (!id.success) return { status: "error", message: "That template could not be identified" };

  try {
    await deleteTaskTemplate(getDb(), session.organisationId, {
      templateId: id.data.templateId, actorKind: "user", actorId: session.userId,
    });
    revalidate();
    return { status: "ok", id: id.data.templateId };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
