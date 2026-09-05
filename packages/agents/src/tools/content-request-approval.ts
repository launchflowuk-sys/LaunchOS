import { ContentRefused, requestContentApproval } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { CONTENT_WRITER_KEY } from "./content-shared.js";

export type ContentRequestApprovalResult =
  | { requested: true; itemId: string; approvalId: string; status: string; summary: string }
  | { requested: false; itemId: string; reason: string };

/**
 * Puts a drafted slot in front of the owner as a `content_publish` approval.
 *
 * This is the human gate for everything the writer produces, and it is the
 * *only* gate — which is why the tool is `safe` to the kernel's policy gate
 * rather than `requires_approval`. Marking it `requires_approval` would have
 * the kernel park the run on a `tool_call` approval, and approving *that*
 * would then execute this tool, which would raise the `content_publish` card
 * — two decisions for one post, and a run that parks once per slot with an
 * LLM round-trip between each. Instead the tool executes at once, creates the
 * `content_publish` approval through core (the same card a staff member's
 * "Send for approval" raises), and the run carries on to the next slot. The
 * item sits `awaiting_approval`; the owner's decision on /approvals is applied
 * by `applyContentPublishDecision`, and an approved item is picked up by the
 * `content.publish-due` sweep at its scheduled time. Nothing publishes
 * without that decision.
 *
 * No `runId` is passed on purpose: an approval with a run behind it is
 * resumed by the kernel rather than applied by the web action, and this run
 * has nothing to resume — it is finished by the time anyone decides.
 *
 * Under `AGENT_POLICY=approval_all` (or the organisation's own policy) the
 * kernel gates this call like every other, so the stricter setting still
 * holds.
 */
export const contentRequestApproval = defineTool({
  name: "content_request_approval",
  description:
    "Send a drafted slot to the owner for approval. Approving it publishes the post at its scheduled time; " +
    "rejecting it sends it back to draft. Call once per slot after content_save_draft. " +
    "Returns { requested: false, reason } if the slot is empty or already waiting.",
  input: z.object({ itemId: z.string().uuid().describe("A slot id you saved a draft onto in this run.") }),
  risk: "safe",
  execute: async ({ itemId }, ctx): Promise<ContentRequestApprovalResult> => {
    try {
      const { item, approval } = await requestContentApproval(ctx.db, ctx.organisationId, {
        itemId,
        actorKind: "agent",
        actorId: CONTENT_WRITER_KEY,
      });
      return { requested: true, itemId: item.id, approvalId: approval.id, status: item.status, summary: approval.title };
    } catch (error) {
      if (error instanceof ContentRefused) return { requested: false, itemId, reason: error.message };
      throw error;
    }
  },
});
