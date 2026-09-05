"use server";

import { createEmailAdapter } from "@launchos/channels";
import {
  activeSubscriptionForClient, createInvoiceFromSubscription, markInvoicePaid, requestInvoiceSendOnce,
  sendApprovedInvoice, voidInvoice,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { type ActionResult, ApprovalRef, ClientRef, InvoiceRef } from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Server Actions accept direct POSTs, so every action re-authorises and re-validates. */
export async function createInvoiceForClient(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = ClientRef.safeParse({ clientId: formData.get("clientId") });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid client" };

  try {
    const db = getDb();
    const subscription = await activeSubscriptionForClient(db, session.organisationId, parsed.data.clientId);
    if (!subscription) return { status: "error", message: "This client has no active subscription to invoice." };

    // No rate is passed: core derives it from the organisation's VAT
    // registration, so an unregistered supplier cannot raise a VAT-charging
    // invoice from this screen no matter what `VAT_RATE` says.
    const invoice = await createInvoiceFromSubscription(db, session.organisationId, {
      subscriptionId: subscription.id,
      actorKind: "user",
      actorId: session.userId,
    });

    revalidatePath("/invoices");
    revalidatePath(`/clients/${parsed.data.clientId}`);
    return { status: "ok", id: invoice.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function markInvoiceAsPaid(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = InvoiceRef.safeParse({ invoiceId: formData.get("invoiceId") });
  if (!parsed.success) return { status: "error", message: "Invalid invoice" };

  try {
    const invoice = await markInvoicePaid(getDb(), session.organisationId, {
      invoiceId: parsed.data.invoiceId, actorKind: "user", actorId: session.userId,
    });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${parsed.data.invoiceId}`);
    revalidatePath(`/clients/${invoice.clientId}`);
    return { status: "ok", id: invoice.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function voidInvoiceAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = InvoiceRef.safeParse({ invoiceId: formData.get("invoiceId") });
  if (!parsed.success) return { status: "error", message: "Invalid invoice" };

  try {
    const invoice = await voidInvoice(getDb(), session.organisationId, {
      invoiceId: parsed.data.invoiceId, actorKind: "user", actorId: session.userId,
    });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${parsed.data.invoiceId}`);
    revalidatePath(`/clients/${invoice.clientId}`);
    return { status: "ok", id: invoice.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Emailing a client is outward-facing, so it queues for approval first.
 *
 * `requestInvoiceSendOnce`, not the raw request: a Server Action accepts direct
 * POSTs, so a replay, a double click or a stale banner would otherwise file a
 * second pending approval for the same invoice. Approving both would email the
 * client the same invoice twice, because the send claim is per-approval. The
 * decision already waiting is named instead of quietly returning a new id.
 */
export async function requestSendInvoice(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = InvoiceRef.safeParse({ invoiceId: formData.get("invoiceId") });
  if (!parsed.success) return { status: "error", message: "Invalid invoice" };

  try {
    const { approval, alreadyPending } = await requestInvoiceSendOnce(getDb(), session.organisationId, {
      invoiceId: parsed.data.invoiceId, actorId: session.userId,
    });
    if (alreadyPending) {
      return {
        status: "error",
        message: "A send for this invoice is already waiting in Approvals — approve or reject that decision instead of queueing another.",
      };
    }
    revalidatePath("/approvals");
    revalidatePath(`/invoices/${parsed.data.invoiceId}`);
    return { status: "ok", id: approval.id };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Executes an invoice-send approval that a human has already approved.
 *
 * The approvals screen owns the decision itself; this is the half that belongs
 * to invoices, kept here so the two modules stay independently editable. The
 * approvals page needs a branch for approvals that carry no `runId` — an
 * invoice send is raised by a person, not an agent run — which calls this after
 * recording the decision. Wiring that branch is the last task of Plan 5.
 */
export async function sendApprovedInvoiceAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = ApprovalRef.safeParse({ approvalId: formData.get("approvalId") });
  if (!parsed.success) return { status: "error", message: "Invalid approval" };

  try {
    const { invoiceId, alreadySent } = await sendApprovedInvoice(
      getDb(),
      session.organisationId,
      { approvalId: parsed.data.approvalId, actorId: session.userId },
      createEmailAdapter(process.env),
      process.env.APP_URL ?? "http://localhost:3000",
    );
    // A spent approval is not a send. Reporting it as `ok` would tell the
    // operator the client was emailed when nothing left the building.
    if (alreadySent) {
      return {
        status: "error",
        message: "This invoice was already sent by an earlier decision — nothing was emailed. Request a new send to email it again.",
      };
    }
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/approvals");
    return { status: "ok", id: invoiceId };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
