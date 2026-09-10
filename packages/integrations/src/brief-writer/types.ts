import { z } from "zod";

/**
 * The structured brief a model writes from a submitted questionnaire.
 *
 * The shape follows `brief.schema.json` from the handoff. It is declared as Zod
 * rather than imported as JSON Schema so the same definition validates the
 * model's reply and types the code that reads it — two copies of a contract
 * drift, and the one that drifts is always the one nobody validates against.
 *
 * The parts that matter are the ones that keep the model honest:
 *
 * - `sourcePaths` on every requirement, naming the answers it came from. A
 *   requirement that cannot cite an answer is one the model invented.
 * - `basis` separating what the customer actually said from what we are
 *   proposing. Those two must never arrive at a client looking alike.
 * - `openQuestions` and `assumptions`, so a gap is stated rather than filled
 *   with something plausible.
 */

export const BriefRequirement = z.object({
  id: z.string().min(1).max(64),
  description: z.string().min(1).max(2000),
  priority: z.enum(["must", "should", "could"]),
  /** Where this came from. `stated` is theirs; `proposed` is ours. */
  basis: z.enum(["stated", "proposed", "assumed"]),
  /** Answer keys backing it. Empty is only valid for `proposed`. */
  sourcePaths: z.array(z.string().max(120)).max(20),
  acceptanceCriteria: z.array(z.string().max(500)).max(10).optional(),
});
export type BriefRequirement = z.infer<typeof BriefRequirement>;

export const BriefPage = z.object({
  path: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  purpose: z.string().max(1000),
  sections: z.array(z.string().max(200)).max(20),
  basis: z.enum(["stated", "proposed", "assumed"]),
  sourcePaths: z.array(z.string().max(120)).max(20),
});

export const StructuredBrief = z.object({
  schemaVersion: z.literal("1"),
  projectTitle: z.string().min(1).max(200),
  businessSummary: z.string().min(1).max(4000),
  targetAudience: z.string().max(2000),
  goals: z.array(z.string().max(300)).max(20),
  sitemap: z.array(BriefPage).max(40),
  requirements: z.array(BriefRequirement).max(80),
  design: z.object({
    direction: z.string().max(500),
    colours: z.string().max(300),
    referenceUrls: z.array(z.string().max(500)).max(20),
    accessibilityNotes: z.string().max(1000).optional(),
  }),
  contentPlan: z.array(z.object({
    page: z.string().max(200),
    needed: z.string().max(1000),
    responsibility: z.enum(["client", "launchflow", "unknown"]),
  })).max(40),
  integrations: z.array(z.object({
    name: z.string().max(200),
    purpose: z.string().max(1000),
    /** Never "we have access" — the customer wanting a thing is not proof it exists. */
    accessStatus: z.enum(["unknown", "client_has", "needs_setup"]),
    questions: z.array(z.string().max(500)).max(10),
  })).max(20),
  budgetAndTiming: z.object({
    statedBudget: z.string().max(200),
    statedTiming: z.string().max(200),
    targetDate: z.string().max(40).optional(),
    /** Always false. A brief is not a quotation and must never read as one. */
    isQuote: z.literal(false),
  }),
  openQuestions: z.array(z.string().max(500)).max(40),
  assumptions: z.array(z.string().max(500)).max(40),
  excludedScope: z.array(z.string().max(500)).max(40),
  buildConsiderations: z.array(z.string().max(500)).max(40),
  requiresStaffReview: z.literal(true),
});
export type StructuredBrief = z.infer<typeof StructuredBrief>;

export interface BriefWriterInput {
  /** The frozen submission answers. Contact details are stripped before this. */
  answers: Record<string, unknown>;
  reference: string;
}

export interface WrittenBrief {
  structured: StructuredBrief;
  markdown: string;
  model: string;
}

export class BriefWriterError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "BriefWriterError";
  }
}

export interface BriefWriterAdapter {
  readonly name: "mock" | "openai";
  readonly live: boolean;
  write(input: BriefWriterInput): Promise<WrittenBrief>;
}
