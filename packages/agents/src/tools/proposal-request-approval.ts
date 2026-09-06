import { ProposalRefused, requestProposalApproval } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { PROPOSAL_DRAFTER_KEY } from "./proposal-shared.js";

export type ProposalRequestApprovalResult =
  | { requested: true; proposalId: string; reference: string; approvalId: string; summary: string }
  | { requested: false; proposalId: string; reason: string };

/**
 * Puts the finished draft in front of Shoji as a `proposal_send` approval.
 *
 * This is the human gate on a price leaving the building, and it is the *only*
 * gate — which is why the tool is `safe` to the kernel's policy gate rather
 * than `requires_approval`. Marking it `requires_approval` would have the
 * kernel park the run on a `tool_call` approval, and approving *that* would
 * then execute this tool, which would raise the `proposal_send` card — two
 * decisions for one quote, and a run that stops for an LLM round-trip between
 * them. Instead the tool executes at once, creates the `proposal_send`
 * approval through core (the same card the admin's "Send for approval" button
 * raises), and the run finishes. The proposal stays a draft; Shoji's decision
 * on /approvals is carried out by `applyProposalSendDecision` in the worker,
 * which is where the PDF can actually be rendered. Nothing reaches the client
 * without that decision.
 *
 * No `runId` is passed on purpose: an approval with a run behind it is resumed
 * by the kernel rather than applied by the decision path, and this run has
 * nothing to resume — it is finished by the time anyone reads the card.
 *
 * Under `AGENT_POLICY=approval_all` (or the organisation's own policy) the
 * kernel gates this call like every other, so the stricter setting still holds.
 */
export const proposalRequestApproval = defineTool({
  name: "proposal_request_approval",
  description:
    "Send the drafted proposal to Shoji for approval. Approving it emails the client the PDF and the link they accept on; " +
    "rejecting it leaves the draft alone to be edited. Call once, after proposal_save_draft. " +
    "Returns { requested: false, reason } if it is already waiting, has no price, or has nobody to send it to.",
  input: z.object({ proposalId: z.string().uuid().describe("The id proposal_save_draft returned in this run.") }),
  risk: "safe",
  execute: async ({ proposalId }, ctx): Promise<ProposalRequestApprovalResult> => {
    try {
      const { proposal, approval } = await requestProposalApproval(ctx.db, ctx.organisationId, {
        proposalId,
        actorKind: "agent",
        actorId: PROPOSAL_DRAFTER_KEY,
        now: ctx.now(),
      });
      return { requested: true, proposalId, reference: proposal.reference, approvalId: approval.id, summary: approval.title };
    } catch (error) {
      if (error instanceof ProposalRefused) return { requested: false, proposalId, reason: error.message };
      throw error;
    }
  },
});
