"use server";

import { cancelSubscription, createSubscription } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getPayments } from "@/lib/integrations";
import { requireAdmin } from "@/lib/session";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

const StartSubscription = z.object({
  clientId: z.string().uuid(),
  packageId: z.string().uuid("Choose a package"),
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
  const session = await requireAdmin();
  const parsed = StartSubscription.safeParse({
    clientId: formData.get("clientId"),
    packageId: formData.get("packageId"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid subscription" };

  try {
    const { subscription } = await createSubscription(
      getDb(),
      session.organisationId,
      { clientId: parsed.data.clientId, packageId: parsed.data.packageId, actorKind: "user", actorId: session.userId },
      getPayments(),
    );
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: subscription.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function cancelSubscriptionAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
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
