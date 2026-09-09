"use server";

import { assignSupplierCost, syncSupplierCosts } from "@launchos/core";
import { createIntegrations } from "@launchos/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

const AssignInput = z.object({
  costId: z.string().uuid(),
  clientId: z.union([z.literal(""), z.string().uuid()]),
});

/**
 * Attributing a cost to a client — the answer the sync can only guess at,
 * because a supplier names a subscription after the product (".LIVE Domain")
 * and never after the domain. Confirmed here, and never overwritten by a
 * later sync.
 */
export async function assignCostAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };

  const parsed = AssignInput.safeParse({ costId: formData.get("costId"), clientId: formData.get("clientId") ?? "" });
  if (!parsed.success) return { status: "error", message: "That cost could not be identified" };

  try {
    await assignSupplierCost(getDb(), gate.session.organisationId, {
      costId: parsed.data.costId,
      clientId: parsed.data.clientId === "" ? null : parsed.data.clientId,
      actorId: gate.session.userId,
    });
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save that" };
  }
  revalidatePath("/settings/costs");
  revalidatePath("/clients", "layout");
  return { status: "ok" };
}

/** Pulls the supplier's subscriptions in now, rather than waiting for the nightly job. */
export async function syncCostsAction(): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };

  const registrar = createIntegrations(process.env).registrar;
  if (!registrar) {
    return { status: "error", message: "No registrar is configured. Set HOSTINGER_API_TOKEN to sync costs." };
  }

  try {
    const result = await syncSupplierCosts(getDb(), gate.session.organisationId, registrar);
    revalidatePath("/settings/costs");
    return { status: "ok", id: `${result.created} new, ${result.updated} updated` };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "The supplier could not be reached" };
  }
}
