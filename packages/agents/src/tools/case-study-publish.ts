import { CaseStudyRefused, getCaseStudy, publishCaseStudy, whyNotPublishable } from "@launchos/core";
import { z } from "zod";
import { defineTool, type ApprovalDescription } from "../kernel/types.js";
import { CASE_STUDY_WRITER_KEY } from "./project-shared.js";

export type CaseStudyPublishResult =
  /** `published: false` with a slug is a story that was already live — a no-op, not a failure. */
  | { published: boolean; caseStudyId: string; slug: string; status: string }
  | { published: false; caseStudyId: string; reason: string };

/**
 * Puts the story on the public Work page.
 *
 * **`requires_approval`, and this is the one in P4 that genuinely earns it.**
 * Every other tool the two project agents have writes a draft, a card or a
 * note that a person reads before anything leaves the building. This one makes
 * a page the whole internet can read, about a real client's business, under
 * LaunchFlow's name — and a published page is cached, scraped and archived
 * long before anybody notices a sentence was wrong.
 *
 * So it is gated the *kernel's* way rather than the way
 * `project_update_request_approval` is. The reasoning that makes a
 * card-raising tool `safe` — the card is the gate, so gating the tool as well
 * is two decisions for one action — does not apply here, because there is no
 * card in between: this tool *is* the outward action. The kernel parks the run
 * on the approval, `describeApproval` puts the whole story on it, and
 * approving resumes the run, which then executes this and publishes. Rejecting
 * leaves the draft exactly as editable as it was.
 *
 * The card is named `case_study_publish` rather than the generic `tool_call`
 * so it is recognisable in a queue beside a DNS change and a content post —
 * see `ToolDefinition.approvalKind`. Nothing on the resume path reads the
 * kind, so that is a label and not a mechanism.
 */
export const caseStudyPublish = defineTool({
  name: "case_study_publish",
  description:
    "Publish the story to the public Work page. This needs Shoji's approval and he will read the whole thing first. " +
    "Call it once, last, after case_study_save_draft — and only when every part of the brief says something real.",
  input: z.object({
    caseStudyId: z.string().uuid().describe("The case study you have just written."),
  }).strict(),
  risk: "requires_approval",
  approvalKind: "case_study_publish",
  /**
   * What Shoji reads before releasing it: the story itself, from the row, not
   * the model's account of the story. A card that said "the agent would like
   * to publish a case study" would be a decision made blind.
   */
  describeApproval: async ({ caseStudyId }, ctx): Promise<ApprovalDescription> => {
    const study = await getCaseStudy(ctx.db, ctx.organisationId, caseStudyId);
    if (!study) {
      return { title: "Publish a case study", summary: `Case study ${caseStudyId} could not be found.` };
    }
    const blocked = whyNotPublishable(study);
    return {
      title: `Publish the story: ${study.name}`,
      summary:
        `This puts ${study.name} on the public Work page at /work/${study.slug}, where anyone can read it.` +
        (blocked ? ` It is not ready yet: ${blocked}` : ""),
      details: {
        slug: study.slug,
        client: study.clientName ?? "—",
        sector: study.sector,
        summary: study.summary,
        "Who they are": study.brief.client,
        "The problem": study.brief.problem,
        "What we built": study.brief.built,
        "What changed": study.brief.results,
        stack: study.stack.join(", "),
        url: study.url ?? "—",
        ...(blocked ? { "Not ready": blocked } : {}),
      },
    };
  },
  execute: async ({ caseStudyId }, ctx): Promise<CaseStudyPublishResult> => {
    try {
      const { caseStudy, published } = await publishCaseStudy(ctx.db, ctx.organisationId, {
        caseStudyId,
        // The approver is the actor when there is one: the decision was theirs,
        // and the audit row should say so rather than naming the agent.
        actorKind: ctx.approvedByUserId ? "user" : "agent",
        actorId: ctx.approvedByUserId ?? CASE_STUDY_WRITER_KEY,
      });
      return { published, caseStudyId: caseStudy.id, slug: caseStudy.slug, status: caseStudy.status };
    } catch (error) {
      if (error instanceof CaseStudyRefused) return { published: false, caseStudyId, reason: error.message };
      throw error;
    }
  },
});
