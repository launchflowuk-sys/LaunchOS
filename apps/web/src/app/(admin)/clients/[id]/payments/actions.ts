"use server";

import { setSubscriptionLines } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * Saves what a monthly charge is made of.
 *
 * Amounts arrive as pounds because that is what somebody types; they are
 * converted here and stored as pence, so no rounding happens twice. A blank
 * or malformed row is dropped rather than saved as £0 — an empty row is
 * somebody who stopped typing, not a line worth nothing.
 */
const Line = z.object({
  description: z.string().trim().max(300),
  quantity: z.coerce.number().int().min(1).max(999).catch(1),
  unitPounds: z.coerce.number().min(0).max(1_000_000).catch(0),
});

export async function saveSubscriptionLinesAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };

  const subscriptionId = z.string().uuid().safeParse(formData.get("subscriptionId"));
  const clientId = z.string().uuid().safeParse(formData.get("clientId"));
  if (!subscriptionId.success || !clientId.success) {
    return { status: "error", message: "That subscription could not be identified" };
  }

  const descriptions = formData.getAll("description").map(String);
  const quantities = formData.getAll("quantity").map(String);
  const amounts = formData.getAll("unitPounds").map(String);

  const lines = descriptions
    .map((description, index) =>
      Line.safeParse({ description, quantity: quantities[index] ?? "1", unitPounds: amounts[index] ?? "0" }))
    .filter((parsed) => parsed.success && parsed.data.description.length > 0)
    .map((parsed) => ({
      description: parsed.data!.description,
      quantity: parsed.data!.quantity,
      // Rounded once, here, from pounds to pence.
      unitAmountPence: Math.round(parsed.data!.unitPounds * 100),
    }));

  const method = z
    .enum(["stripe", "bank_transfer", "standing_order", "direct_debit", "cash", "other"])
    .safeParse(formData.get("collectionMethod"));

  try {
    await setSubscriptionLines(getDb(), gate.session.organisationId, {
      subscriptionId: subscriptionId.data,
      lines,
      ...(method.success ? { collectionMethod: method.data } : {}),
      billingNotes: String(formData.get("billingNotes") ?? "").trim() || null,
      actorId: gate.session.userId,
    });
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save that" };
  }

  revalidatePath(`/clients/${clientId.data}/payments`);
  revalidatePath("/payments");
  return { status: "ok" };
}
