import { LeadReplyRefused, requestLeadReply } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const LEAD_QUALIFIER_KEY = "lead-qualifier";
/** The prompt's word limit for the body; enforced here as a refusal returned as data. */
export const LEAD_REPLY_MAX_WORDS = 160;

export type LeadDraftReplyResult =
  | { drafted: true; leadId: string; approvalId: string; title: string }
  | { drafted: false; leadId: string; reason: string };

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Puts the drafted first reply in front of the owner as a `lead_reply`
 * approval. Nothing is sent by this tool: the email leaves only when a human
 * approves the card on /approvals (`applyLeadReplyDecision`), and the card's
 * textarea is the body that goes out, so the owner can edit before sending.
 *
 * `risk: "safe"` to the kernel's policy gate, for the reason
 * `content_request_approval` gives: the `lead_reply` card *is* the human gate.
 * Marking this `requires_approval` would park the run on a `tool_call`
 * approval whose approval would then raise the `lead_reply` card — two
 * decisions for one email. Under `AGENT_POLICY=approval_all` the kernel
 * still gates the call like every other. The approval is run-less (no
 * `runId`) so the web action applies it rather than the kernel resuming a
 * run that has nothing left to do.
 */
export const leadDraftReply = defineTool({
  name: "lead_draft_reply",
  description:
    "Send your drafted reply to the owner for approval. Plain text, British English, at most 120 words, two or three clarifying questions, " +
    "one suggested package by slug with its monthly price. A human approves it before it is emailed; the booking link is appended automatically — do not write it yourself. " +
    "Returns { drafted: false, reason } if the lead has no email or a draft is already waiting.",
  input: z.object({
    leadId: z.string().uuid(),
    subject: z.string().trim().min(1).max(120).describe("Short and specific, e.g. 'Your website for Khan Dental'."),
    body: z.string().trim().min(1).max(2500).describe("The reply itself. No sign-off line needed beyond 'Shoji'. No markdown."),
    suggestedPackageSlug: z.string().trim().min(1).max(60).optional().describe("A slug from packages_list."),
    questions: z.array(z.string().trim().min(1).max(200)).min(1).max(3).describe("The clarifying questions the body asks, listed for the card."),
  }),
  risk: "safe",
  execute: async (input, ctx): Promise<LeadDraftReplyResult> => {
    if (wordCount(input.body) > LEAD_REPLY_MAX_WORDS) {
      return { drafted: false, leadId: input.leadId, reason: `The body is ${wordCount(input.body)} words; keep it under 120. Shorten it and call again.` };
    }
    try {
      const { approval } = await requestLeadReply(ctx.db, ctx.organisationId, {
        leadId: input.leadId, subject: input.subject, body: input.body,
        ...(input.suggestedPackageSlug ? { suggestedPackageSlug: input.suggestedPackageSlug } : {}),
        questions: input.questions, actorKind: "agent", actorId: LEAD_QUALIFIER_KEY,
      });
      return { drafted: true, leadId: input.leadId, approvalId: approval.id, title: approval.title };
    } catch (error) {
      if (error instanceof LeadReplyRefused) return { drafted: false, leadId: input.leadId, reason: error.message };
      throw error;
    }
  },
});
