"use server";

import { createEmailAdapter } from "@launchos/channels";
import { decideApproval, INVOICE_SEND_ACTION, recordAudit, releaseApprovalClaim, sendApprovedInvoice } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { sendJob } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

const DecisionInput = z.object({
  approvalId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});

/** What a human-raised (run-less) approval carries instead of a tool call. */
const NonAgentPayload = z.object({ action: z.string() });

/**
 * Hands the decision to the worker. Returns pg-boss's job id, or null when the
 * send was deduped away — with a per-approval singleton key and a claim that
 * only one decision can win, a dedupe means an earlier job for this approval is
 * still in flight, so this decision has nothing driving it either way and the
 * caller must put the approval back.
 */
async function queueResume(
  organisationId: string,
  runId: string,
  approvalId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<string | null> {
  return sendJob(
    "agent.resume",
    { organisationId, runId, approvalId, decision, ...(note ? { note } : {}) },
    // One resume per approval, however many times the button is pressed.
    { singletonKey: `resume:${approvalId}` },
  );
}

async function decide(formData: FormData, status: "approved" | "rejected"): Promise<ActionResult> {
  // Server Actions accept direct POSTs, so authorise here and scope every
  // query by the caller's organisation.
  const session = await requireAdmin();
  const raw = formData.get("note");
  const parsed = DecisionInput.safeParse({
    approvalId: formData.get("approvalId"),
    ...(typeof raw === "string" && raw.trim().length > 0 ? { note: raw } : {}),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid decision" };
  }
  const { approvalId, note } = parsed.data;

  try {
    // One conditional UPDATE claims the approval. Everything below — the resume
    // job, the invoice email, the audit row — happens only for the decision
    // that won the claim, so a double click, or approve-then-reject, cannot
    // queue two resumes or send the same invoice twice.
    const decision = await decideApproval(getDb(), session.organisationId, {
      approvalId,
      decision: status,
      decidedByUserId: session.userId,
      ...(note ? { note } : {}),
    });

    if (decision.alreadyDecided) {
      return {
        status: "error",
        message: decision.approval
          ? "That approval has already been decided."
          : "That approval is not waiting for a decision.",
      };
    }

    const { before, after } = decision;

    if (before.runId) {
      // `decideApproval` has already stamped the whole decision — status,
      // `decided_by`, `decided_at`, the note — and the kernel reads it from
      // there rather than from this payload, so the approver on the card, in
      // the audit log and in the database can never disagree. The job carries
      // the decision only as a cross-check; what tells the kernel the decision
      // has not been carried out yet is the run's own `metadata.pending`.
      //
      // The claim is released if the job cannot be queued. A decided approval
      // whose run is still parked, with nothing anywhere that will resume it,
      // is the one outcome worse than "press it again".
      const queued = await queueResume(session.organisationId, before.runId, approvalId, status, note).catch(
        (err: unknown) => {
          console.error("agent.resume could not be queued", {
            approvalId,
            err: err instanceof Error ? err.message : String(err),
          });
          return null;
        },
      );
      if (queued === null) {
        await releaseApprovalClaim(getDb(), session.organisationId, { approvalId, decidedAt: after.decidedAt! });
        revalidatePath("/approvals");
        return { status: "error", message: "Could not queue the agent resume. The decision was not recorded — try again." };
      }
      await recordAudit(getDb(), session.organisationId, {
        actorKind: "user",
        actorId: session.userId,
        action: `approval.${status}_queued`,
        targetType: "approval",
        targetId: approvalId,
        before,
        after,
      });
    } else {
      // Nothing resumes an approval with no run behind it, so there is no job
      // to queue and the decision `decideApproval` stamped is final here.
      await recordAudit(getDb(), session.organisationId, {
        actorKind: "user",
        actorId: session.userId,
        action: `approval.${status}`,
        targetType: "approval",
        targetId: approvalId,
        before,
        after,
      });

      // A run-less approval is a person asking for an outward-facing action, so
      // approving it has to *do* the thing — recording the decision alone would
      // leave the invoice unsent with nothing to say so. Rejecting records the
      // decision and stops. A throw from the send reaches the catch below and
      // is shown to the approver: "no email address", "invoice is paid" and the
      // like are answers they need, not noise to swallow.
      const payload = NonAgentPayload.safeParse(before.payload);
      if (status === "approved" && payload.success && payload.data.action === INVOICE_SEND_ACTION) {
        const { invoiceId } = await sendApprovedInvoice(
          getDb(),
          session.organisationId,
          { approvalId, actorId: session.userId },
          createEmailAdapter(process.env),
          env.APP_URL,
        );
        revalidatePath("/invoices");
        revalidatePath(`/invoices/${invoiceId}`);
      }
    }

    revalidatePath("/approvals");
    revalidatePath("/");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export async function approveApproval(formData: FormData): Promise<ActionResult> {
  return decide(formData, "approved");
}

export async function rejectApproval(formData: FormData): Promise<ActionResult> {
  return decide(formData, "rejected");
}
