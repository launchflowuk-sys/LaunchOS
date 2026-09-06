import {
  ProposalRefused,
  applyProposalSendDecision,
  getProposalAcceptance,
  getProposalDetail,
  proposalSendsAwaitingApplication,
  proposalsAwaitingFollowOn,
  sendProposal,
  type ProposalAcceptedJobData,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import { QUEUE } from "../boss.js";
import type { BossRegistrar } from "./content-jobs.js";
import { sweepOrganisations, type SweepOrganisationsLogger } from "./sweep-organisations.js";

/**
 * The only place a proposal can actually be sent.
 *
 * `sendProposal` renders a PDF, and `playwright` is a dependency of this
 * process and not of `apps/web` — so a send from a Next.js route handler works
 * on a laptop and fails on Coolify. Everything that wants a proposal to go out
 * — an approved `proposal_send` card, the admin Send button — enqueues here.
 *
 * The same queue carries a two-minute tick with an empty payload, which is the
 * delivery insurance under both hand-offs: a decision whose job was lost, and
 * an acceptance whose follow-on never reached the queue. Neither sweep undoes
 * anything; what it repairs is the *delivery*, not the decision.
 */

export const PROPOSAL_SEND_SWEEP_CRON = "*/2 * * * *";

/**
 * `{ approvalId }` for a decided card, `{ proposalId }` for a send a person
 * asked for directly, and `{ organisationId }` alone for nothing at all — the
 * cron's tick is `{}`.
 */
export interface ProposalSendJob {
  organisationId?: string;
  approvalId?: string;
  proposalId?: string;
  /** The staff user who pressed the button, for the audit trail. */
  actorId?: string;
}

export interface ProposalSendDeps {
  readonly db: Db;
  readonly logger?: SweepOrganisationsLogger & Pick<Console, "info" | "warn" | "error">;
}

export interface ProposalSendResult {
  sent: boolean;
  proposalId: string | null;
  reason?: string;
}

/** Sends one proposal, or carries out one decided card. */
export async function handleProposalSend(deps: ProposalSendDeps, job: ProposalSendJob): Promise<ProposalSendResult> {
  const logger = deps.logger ?? console;
  if (!job.organisationId) return { sent: false, proposalId: null, reason: "no organisation on the job" };

  if (job.approvalId) {
    const result = await applyProposalSendDecision(deps.db, job.organisationId, {
      approvalId: job.approvalId,
      ...(job.actorId ? { actorId: job.actorId } : {}),
    });
    return { sent: result.sent, proposalId: result.proposalId, ...(result.alreadyApplied ? { reason: "already applied" } : {}) };
  }

  if (!job.proposalId) return { sent: false, proposalId: null, reason: "nothing to send" };
  try {
    await sendProposal(deps.db, job.organisationId, {
      proposalId: job.proposalId,
      actorKind: job.actorId ? "user" : "system",
      ...(job.actorId ? { actorId: job.actorId } : {}),
    });
    return { sent: true, proposalId: job.proposalId };
  } catch (error) {
    // A refusal is a business answer, not a fault: a proposal already sent, or
    // one whose price or recipient went missing between the click and the job.
    // Retrying it five times would only repeat the same answer.
    if (error instanceof ProposalRefused) {
      logger.warn({ organisationId: job.organisationId, proposalId: job.proposalId, reason: error.reason }, "proposal not sent");
      return { sent: false, proposalId: job.proposalId, reason: error.message };
    }
    throw error;
  }
}

export interface ProposalSweepTotals {
  organisations: number;
  applied: number;
  followOnRequeued: number;
}

/**
 * The two-minute pass: decided cards nobody carried out, and acceptances whose
 * follow-on never got away.
 *
 * Both are people already waiting — a client who was told their proposal was
 * coming, and a client who has agreed and is expecting a payment link — so
 * this runs on a short clock rather than with the daily sweeps below.
 */
export async function runProposalSendSweep(deps: ProposalSendDeps & { boss: BossRegistrar }): Promise<ProposalSweepTotals> {
  const logger = deps.logger ?? console;
  const totals: ProposalSweepTotals = { organisations: 0, applied: 0, followOnRequeued: 0 };
  await sweepOrganisations(deps.db, "proposal send sweep", async (organisationId) => {
    totals.organisations += 1;
    for (const approval of await proposalSendsAwaitingApplication(deps.db, organisationId)) {
      const result = await applyProposalSendDecision(deps.db, organisationId, { approvalId: approval.id });
      if (!result.alreadyApplied) totals.applied += 1;
      logger.info({ organisationId, approvalId: approval.id, ...result }, "proposal decision applied late");
    }
    for (const proposal of await proposalsAwaitingFollowOn(deps.db, organisationId)) {
      const job = await followOnJobFor(deps.db, organisationId, proposal.id);
      if (!job) continue;
      await deps.boss.send(QUEUE.proposalsAccepted, job, { singletonKey: `proposal-accepted:${proposal.id}` });
      totals.followOnRequeued += 1;
      logger.info({ organisationId, proposalId: proposal.id }, "proposal follow-on re-queued");
    }
  }, logger);
  return totals;
}

/**
 * Rebuilds the follow-on payload from the rows.
 *
 * `acceptProposal` carries the amounts on the job rather than re-reading them,
 * so a job cannot act on a price that changed after the client agreed. A
 * re-queue has no such job to copy, so it reads them back — which is safe for
 * the same reason the amounts are derived from lines and a sent proposal is
 * frozen: neither the lines nor the shape can have moved since.
 */
export async function followOnJobFor(db: Db, organisationId: string, proposalId: string): Promise<ProposalAcceptedJobData | null> {
  const detail = await getProposalDetail(db, organisationId, proposalId);
  if (!detail) return null;
  const acceptance = detail.acceptance ?? (await getProposalAcceptance(db, organisationId, proposalId));
  if (!acceptance) return null;
  return {
    organisationId,
    proposalId,
    acceptanceId: acceptance.id,
    clientId: detail.proposal.clientId,
    shape: detail.proposal.pricing.shape,
    dueOnAcceptancePence: detail.totals.dueOnAcceptancePence,
    recurringMonthlyPence: detail.totals.recurringMonthlyPence,
    packageId: detail.proposal.packageId,
  };
}
