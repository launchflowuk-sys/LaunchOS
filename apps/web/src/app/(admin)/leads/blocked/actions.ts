"use server";

import { addSuppression, removeSuppression } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import type { ActionResult } from "../schemas";

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/** A refusal ("that does not look like a phone number") is a sentence, not a 500. */
function failed(error: unknown, fallback: string): ActionResult {
  const message = error instanceof Error ? error.message : fallback;
  if (!(error instanceof Error)) console.error(fallback, error);
  return { status: "error", message };
}

export async function addSuppressionAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const phone = value(formData, "phone")?.trim();
  if (!phone) return { status: "error", message: "Type the number to block" };

  try {
    const { row } = await addSuppression(getDb(), session.organisationId, {
      phone,
      note: value(formData, "note")?.trim() || undefined,
      actorId: session.userId,
    });
    revalidatePath("/leads/blocked");
    return { status: "ok", id: row.id };
  } catch (error) {
    return failed(error, "Could not block that number");
  }
}

export async function removeSuppressionAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const id = value(formData, "id");
  if (!id) return { status: "error", message: "Nothing to unblock" };

  try {
    await removeSuppression(getDb(), session.organisationId, { id, actorId: session.userId });
    revalidatePath("/leads/blocked");
    return { status: "ok", id };
  } catch (error) {
    return failed(error, "Could not unblock that number");
  }
}
