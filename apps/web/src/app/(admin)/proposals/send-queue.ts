import { getProposalDetail, hasExpired, isPricedAtNothing, type ProposalDetail } from "@launchos/core";
import { QUEUE } from "@launchos/core/queue";
import { getDb } from "@/lib/db";
import { sendJob } from "@/lib/queue";

/**
 * Sending a proposal, from a process that cannot render one.
 *
 * `sendProposal` renders the PDF with Playwright's Chromium, and `playwright`
 * is a dependency of `apps/worker`, deliberately not of this app — a send from
 * a route handler would work on a laptop and fail on Coolify. So the web
 * queues the work and the worker does it, which is also the honest shape: a
 * render, a file write and an email have no business inside the request that
 * pressed the button.
 *
 * Two shapes of job, both consumed by `apps/worker/src/jobs/proposals-send.ts`:
 * `{ proposalId }` for a person pressing Send, and `{ approvalId }` for a
 * decided `proposal_send` card, which the worker carries out through
 * `applyProposalSendDecision`.
 */

/** What the worker's `ProposalSendJob` accepts. Ids only: it reads the rows itself. */
export interface ProposalSendJob {
  organisationId: string;
  proposalId?: string;
  approvalId?: string;
  /** Who pressed the button, so the audit trail names a person rather than the worker. */
  actorId?: string;
}

/**
 * Everything `sendProposal` refuses, checked before the job is queued.
 *
 * Core refuses these itself and would refuse them again in the worker — but
 * there the refusal is a log line nobody reads, and the person who pressed
 * Send has been told it was on its way. These are the same four
 * `requestProposalApproval` checks, in the same order.
 */
export function whySendRefused(detail: ProposalDetail, now = new Date()): string | null {
  const { proposal, totals, recipient } = detail;
  if (proposal.status !== "draft") {
    return `Proposal ${proposal.reference} has already been sent — write a new one rather than sending this again.`;
  }
  if (!recipient) {
    return "There is no email address on the lead or client this proposal is for. Add one first.";
  }
  if (isPricedAtNothing(totals)) {
    return `Proposal ${proposal.reference} has nothing priced on it yet — add the lines first.`;
  }
  if (hasExpired(proposal, now)) {
    return `Proposal ${proposal.reference} is dated to expire already — move the valid-until date first.`;
  }
  return null;
}

export type SendQueueResult = { ok: true } | { ok: false; message: string };

/**
 * Queues one send for a proposal a person asked to send.
 *
 * Keyed on the proposal, so a double press is one job while the first is
 * still queued; core's own `not_sendable` refusal is what stops a second send
 * once the first has run.
 */
export async function queueProposalSend(organisationId: string, proposalId: string, actorId: string): Promise<SendQueueResult> {
  const detail = await getProposalDetail(getDb(), organisationId, proposalId);
  if (!detail) return { ok: false, message: "That proposal could not be found." };
  const refused = whySendRefused(detail);
  if (refused) return { ok: false, message: refused };

  const job: ProposalSendJob = { organisationId, proposalId, actorId };
  await sendJob(QUEUE.proposalsSend, job, { singletonKey: `proposal-send:${proposalId}` });
  return { ok: true };
}

/**
 * Queues the carrying-out of a decided `proposal_send` card — both verdicts.
 *
 * An approval is not finished when the decision is stamped: approving still
 * has to send, and rejecting still owes the proposal's timeline the entry that
 * says it was not sent and why. `applyProposalSendDecision` does both and is
 * at-most-once through its own stamp, so a duplicate job is a no-op rather
 * than a second email.
 */
export async function queueProposalSendDecision(organisationId: string, approvalId: string, proposalId: string, actorId: string): Promise<void> {
  const job: ProposalSendJob = { organisationId, approvalId, actorId };
  await sendJob(QUEUE.proposalsSend, job, { singletonKey: `proposal-send:${proposalId}` });
}
