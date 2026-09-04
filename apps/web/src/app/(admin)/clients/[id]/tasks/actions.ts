"use server";

import { generateOnboardingTasks } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import type { ActionResult } from "../../../tasks/schemas";

const RegenerateSchema = z.object({ clientId: z.string().uuid() });

/**
 * Runs the same idempotent generator the `tasks.generate-onboarding` worker job
 * runs. Useful after changing a client's package, after adding a template, or
 * when the worker was not running at the moment the client was created:
 * generation is keyed on (client, template), so a second run tops up what is
 * missing and touches nothing that already exists.
 */
export async function regenerateOnboardingAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = RegenerateSchema.safeParse({ clientId: formData.get("clientId") });
  if (!parsed.success) return { status: "error", message: "That client could not be identified" };
  const { clientId } = parsed.data;

  try {
    await generateOnboardingTasks(getDb(), session.organisationId, clientId);
    revalidatePath(`/clients/${clientId}/tasks`);
    revalidatePath("/tasks");
    revalidatePath("/");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}
