"use server";

import { createEmailAdapter } from "@launchos/channels";
import {
  applyContentPublishDecision,
  applySubscriptionChangeDecision,
  CONTENT_PUBLISH_ACTION,
  decideApproval,
  INVOICE_SEND_ACTION,
  recordAudit,
  sendApprovedInvoice,
  SUBSCRIPTION_CHANGE_ACTION,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { installWebEnqueue, sendJob } from "@/lib/queue";
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
 * send was deduped away.
 *
 * A `null` is **not** a failure. The job is a bare pointer — the kernel reads
 * the verdict, the note and the approver off the `approvals` row — so a job
 * already queued under `resume:<approvalId>` will carry out exactly this
 * decision when the worker picks it up. `short` dedupes only while the first
 * job is still `created`, which is precisely the case where the pointer is
 * still good.
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
  // A decided plan change queues courtesy emails through `emit`; without the
  // web enqueue installed they would sit `queued` until the outbound sweep.
  installWebEnqueue();
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
      // The enqueue is a *fast path*, nothing more. The decision is already
      // committed and is final; `boss.send` is a single INSERT whose promise
      // can reject after the row landed, so a rejection is "unknown", never
      // "did not happen" — undoing the decision on it would revert an outward
      // action that may already have been sent, with no audit row to say so.
      // A `null` is a dedupe, which means a job that reads this very row is
      // already queued.
      //
      // Either way the decision stands and the `approvals.resume-sweep` cron
      // re-enqueues any decided approval whose run is still parked, so the
      // worst case is a resume that starts a minute late.
      const queued = await queueResume(session.organisationId, before.runId, approvalId, status, note).catch(
        (err: unknown) => {
          console.error("agent.resume could not be queued; the resume sweep will pick it up", {
            approvalId,
            runId: before.runId,
            err: err instanceof Error ? err.message : String(err),
          });
          return null;
        },
      );
      if (queued === null) {
        console.info("agent.resume was not queued by this request (deduped or unreachable); leaving it to the sweep", {
          approvalId,
          runId: before.runId,
        });
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
      //
      // A plan change request is the one kind a *client* raised, so both
      // verdicts are answers they are waiting on: approve or reject, the
      // decision is carried out and the client's portal users are emailed.
      const payload = NonAgentPayload.safeParse(before.payload);
      if (payload.success && payload.data.action === SUBSCRIPTION_CHANGE_ACTION) {
        const applied = await applySubscriptionChangeDecision(getDb(), session.organisationId, {
          approvalId,
          actorId: session.userId,
        });
        revalidatePath(`/clients/${applied.clientId}`);
        revalidatePath("/portal/plan");
      } else if (payload.success && payload.data.action === CONTENT_PUBLISH_ACTION) {
        // A content item asking to go out: approve makes it `approved` for the
        // publish sweep, reject sends it back — both verdicts land on the item.
        const applied = await applyContentPublishDecision(getDb(), session.organisationId, {
          approvalId,
          actorId: session.userId,
        });
        revalidatePath("/content");
        revalidatePath(`/content/${applied.itemId}`);
        revalidatePath(`/clients/${applied.clientId}`);
        revalidatePath("/portal/content");
      } else if (status === "approved" && payload.success && payload.data.action === INVOICE_SEND_ACTION) {
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
