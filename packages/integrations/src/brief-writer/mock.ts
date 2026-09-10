import type { BriefWriterAdapter, BriefWriterInput, WrittenBrief } from "./types.js";
import { structuredToMarkdown } from "./openai.js";

/**
 * A brief written from the answers with no model involved.
 *
 * Mock-first, per rule 4 — and useful beyond tests. It says only what the
 * answers say, marks everything else as an open question, and is what runs
 * locally and in CI. If this is what a client ends up seeing, it is thin but
 * never wrong, which is the right failure.
 */
export class MockBriefWriter implements BriefWriterAdapter {
  readonly name = "mock" as const;
  readonly live = false;

  async write(input: BriefWriterInput): Promise<WrittenBrief> {
    const answers = input.answers;
    const text = (key: string) => (typeof answers[key] === "string" ? (answers[key] as string) : "");
    const list = (key: string) => (Array.isArray(answers[key]) ? (answers[key] as string[]) : []);
    const title = text("business") || text("name") || "Website project";

    const structured = {
      schemaVersion: "1" as const,
      projectTitle: title,
      businessSummary: text("description") || `${title} — ${text("industry") || "details still to confirm"}.`,
      targetAudience: text("audience"),
      goals: list("goals"),
      // One page per thing they ticked, and nothing they did not.
      sitemap: list("pages").map((page) => ({
        path: page === "home" ? "/" : `/${page.replace(/_/g, "-")}`,
        title: page.replace(/_/g, " "),
        purpose: "",
        sections: [],
        basis: "stated" as const,
        sourcePaths: ["pages"],
      })),
      requirements: list("features").map((feature, index) => ({
        id: `req-${index + 1}`,
        description: feature.replace(/_/g, " "),
        priority: "should" as const,
        basis: "stated" as const,
        sourcePaths: ["features"],
      })),
      design: {
        direction: text("designDirection"),
        colours: text("colours"),
        referenceUrls: text("referenceUrls").split("\n").filter(Boolean).slice(0, 20),
      },
      contentPlan: [],
      integrations: [],
      budgetAndTiming: {
        statedBudget: text("budget"),
        statedTiming: list("timeline").join(", "),
        isQuote: false as const,
      },
      openQuestions: ["Written without the brief writer, so nothing here has been interpreted."],
      assumptions: [],
      excludedScope: [],
      buildConsiderations: [],
      requiresStaffReview: true as const,
    };

    return { structured, markdown: structuredToMarkdown(structured), model: "mock" };
  }
}
