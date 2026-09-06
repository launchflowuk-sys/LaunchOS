"use server";

import { convertLeadToClient, updateLeadStatus } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import { type ActionResult, ConvertLeadSchema, type ConvertLeadValues, firstIssue, UpdateLeadStatusSchema } from "./schemas";

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/** A core refusal ("a converted lead cannot change status") is a sentence for the toast, never a 500. */
function failed(error: unknown, fallback: string): ActionResult {
  const message = error instanceof Error ? error.message : fallback;
  if (!(error instanceof Error)) console.error(fallback, error);
  return { status: "error", message };
}

/**
 * Gated like Clients: any signed-in member. Leads carry no permission key
 * yet (W3a's note) — new business is not billing, support or content, and
 * the team is one person plus staff who should see what is coming in.
 */
export async function updateLeadStatusAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = UpdateLeadStatusSchema.safeParse({ leadId: value(formData, "leadId"), status: value(formData, "status") });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Choose a status") };

  try {
    const lead = await updateLeadStatus(getDb(), session.organisationId, {
      leadId: parsed.data.leadId,
      status: parsed.data.status as "new" | "contacted" | "lost",
      actorId: session.userId,
    });
    revalidatePath("/leads");
    revalidatePath(`/leads/${lead.id}`);
    return { status: "ok", id: lead.id };
  } catch (error) {
    return failed(error, "Could not change the status");
  }
}

/**
 * Makes a client out of the lead. Called from a button rather than a
 * `<form action>` so the form can navigate to the new client on success;
 * `client.created` fires from `createClient` as for any new client, so the
 * web enqueue is installed first and onboarding tasks generate as usual.
 */
export async function convertLeadAction(values: ConvertLeadValues): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = ConvertLeadSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the details and try again") };

  try {
    const { client } = await convertLeadToClient(getDb(), session.organisationId, {
      leadId: parsed.data.leadId,
      actorId: session.userId,
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.packageId ? { packageId: parsed.data.packageId } : {}),
    });
    revalidatePath("/leads");
    revalidatePath(`/leads/${parsed.data.leadId}`);
    revalidatePath("/clients");
    return { status: "ok", id: client.id };
  } catch (error) {
    return failed(error, "Could not convert the lead");
  }
}
