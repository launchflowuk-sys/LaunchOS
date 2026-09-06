/**
 * What the proposal tools share: the agent key every audit and activity row
 * names, and the ceiling the prompt and the tool agree on for a summary.
 */

/** `audit_log.actor_id` and `agent_enablement.agent_key` for the drafter. */
export const PROPOSAL_DRAFTER_KEY = "proposal-drafter";

/**
 * The summary is the paragraph under the title on the PDF and the first thing
 * a client reads. Long enough for three or four sentences, short enough that
 * the model cannot bury the price in an essay.
 */
export const PROPOSAL_SUMMARY_MAX_CHARS = 1200;
