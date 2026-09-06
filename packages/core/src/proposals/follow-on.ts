import type { ProposalPricingShape } from "@launchos/db/schema";

/**
 * What happens *after* a client accepts, and why it is not done inline.
 *
 * Acceptance is one transaction, and three of the things that follow it cannot
 * live inside one: the countersigned PDF needs Chromium (which only the worker
 * has), Stripe Checkout is an HTTP call to somebody else's server, and creating
 * a project is a large write that must not take a client's Accept button down
 * with it if it fails. So `acceptProposal` records the agreement, and hands
 * the rest to a job.
 *
 * The hook is module state with a no-op default, exactly like
 * `events/emit.ts` — `core` may not import pg-boss (CLAUDE.md's dependency
 * direction), so the worker and the web app install the sender at boot. The
 * job's own queue name and payload validation belong to whoever writes the
 * handler; this is the shape they receive.
 *
 * An un-wired process is not a silent loss: `acceptProposal` only stamps
 * `proposals.metadata.followOnQueuedAt` once the queue call has returned, so
 * `proposalsAwaitingFollowOn` in `sweeps.ts` finds anything that never got
 * away, and the worker can pick it up on its next pass.
 */

/** The job name the worker registers. Named here so both sides agree on it. */
export const PROPOSAL_ACCEPTED_JOB = "proposals.accepted";

/** `proposals.metadata` — set once the follow-on job has actually been queued. */
export const FOLLOW_ON_QUEUED_AT = "followOnQueuedAt";

/**
 * Everything the follow-on needs, carried rather than re-derived.
 *
 * `shape` and the two amounts are here because they are what the payment step
 * branches on, and reading them from the row later would mean a job could act
 * on a price that changed after the client agreed — which is precisely the
 * thing an acceptance record exists to prevent.
 */
export interface ProposalAcceptedJobData {
  organisationId: string;
  proposalId: string;
  acceptanceId: string;
  /** Set by acceptance when the proposal was on a lead. Null only in the impossible case. */
  clientId: string | null;
  shape: ProposalPricingShape;
  /** Pence due the moment they accepted — what Checkout opens with. Zero for `monthly_on_delivery`. */
  dueOnAcceptancePence: number;
  /** Pence a month afterwards. Zero for `one_off`. */
  recurringMonthlyPence: number;
  /** The retainer to put them on, when the proposal named one. */
  packageId: string | null;
}

export type ProposalFollowOnFn = (job: ProposalAcceptedJobData) => Promise<void>;

let send: ProposalFollowOnFn = async () => {}; // no-op until the worker or web installs one

/** Installs the sender. Called once at process boot, beside `setEnqueue`. */
export function setProposalFollowOn(fn: ProposalFollowOnFn): void {
  send = fn;
}

/** Hands the follow-on to the queue. Throws what the queue throws; the caller decides. */
export async function queueProposalFollowOn(job: ProposalAcceptedJobData): Promise<void> {
  await send(job);
}
