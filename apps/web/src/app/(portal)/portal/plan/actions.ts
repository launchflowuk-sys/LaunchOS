"use server";

import { requestSubscriptionChange, SubscriptionChangeRefused } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";
import { installWebEnqueue } from "@/lib/queue";
import { firstIssue, PlanChangeSchema, type ActionResult } from "./schemas";

/**
 * Ask LaunchFlow to change the plan.
 *
 * `clientId` comes from the session, never the form: a portal user cannot ask
 * to cancel somebody else's package whatever they post. Nothing changes here —
 * the request is parked in Approvals for a human, and the client is told so.
 */
export async function requestPlanChange(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  installWebEnqueue();

  const parsed = PlanChangeSchema.safeParse({
    kind: formData.get("kind"),
    message: formData.get("message"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };

  try {
    const approval = await requestSubscriptionChange(getDb(), session.organisationId, {
      clientId: session.clientId,
      actorUserId: session.userId,
      kind: parsed.data.kind,
      message: parsed.data.message,
    });
    revalidatePath("/portal/plan");
    revalidatePath("/portal");
    return { status: "ok", id: approval.id };
  } catch (error) {
    // The two refusals are sentences written for the client; anything else is
    // ours to log and theirs to retry.
    if (error instanceof SubscriptionChangeRefused) return { status: "error", message: error.message };
    console.error("portal plan change request failed", error);
    return { status: "error", message: "That request could not be sent. Please try again." };
  }
}
