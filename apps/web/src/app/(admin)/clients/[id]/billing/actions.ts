"use server";

import { cancelSubscription, createSubscription } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getPayments } from "@/lib/integrations";
import { requirePermission } from "@/lib/permissions";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

const StartSubscription = z.object({
  clientId: z.string().uuid(),
  packageId: z.string().uuid("Choose a package"),
  /**
   * The day the retainer starts, and therefore the day every invoice for it is
   * worked out from. Empty means today — the form pre-fills it, but a direct
   * POST need not. `yyyy-mm-dd` from `<input type="date">`, read as UTC midnight
   * so a subscription started on the 5th does not become the 4th for anyone
   * west of London.
   */
  periodStart: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .transform((value) => new Date(`${value}T00:00:00Z`))
    .optional()
    .catch(undefined),
});

const CancelSubscription = z.object({
  clientId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function startSubscriptionAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = StartSubscription.safeParse({
    clientId: formData.get("clientId"),
    packageId: formData.get("packageId"),
    periodStart: formData.get("periodStart"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid subscription" };

  try {
    const { subscription } = await createSubscription(
      getDb(),
      session.organisationId,
      {
        clientId: parsed.data.clientId,
        packageId: parsed.data.packageId,
        ...(parsed.data.periodStart ? { periodStart: parsed.data.periodStart } : {}),
        actorKind: "user",
        actorId: session.userId,
      },
      getPayments(),
    );
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: subscription.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function cancelSubscriptionAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = CancelSubscription.safeParse({
    clientId: formData.get("clientId"),
    subscriptionId: formData.get("subscriptionId"),
  });
  if (!parsed.success) return { status: "error", message: "Invalid subscription" };

  try {
    const subscription = await cancelSubscription(
      getDb(),
      session.organisationId,
      { subscriptionId: parsed.data.subscriptionId, actorKind: "user", actorId: session.userId },
      getPayments(),
    );
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: subscription.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
