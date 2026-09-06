import { CaseStudyRefused, requireCaseStudy, updateCaseStudy } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { CASE_STUDY_BUILT_MAX_CHARS, CASE_STUDY_SECTION_MAX_CHARS, CASE_STUDY_WRITER_KEY } from "./project-shared.js";

export type CaseStudySaveDraftResult =
  | { saved: true; caseStudyId: string; slug: string; status: string }
  | { saved: false; caseStudyId: string; reason: string };

/**
 * The write half of the allow-list, and the reason it is a schema rather than
 * a sentence in a prompt.
 *
 * **The fields below are the entire vocabulary of this tool.** A story can
 * carry a name, a sector, a one-line summary, four paragraphs of brief, the
 * stack, the year and a public URL. There is no field for a price, a fee, a
 * budget, a margin, a login, a hosting provider, a plugin vendor, a staff
 * member, an internal note, a client's email address or anything marked
 * private — so a model that has somehow been talked into wanting to publish
 * one has nowhere to put it. Zod refuses an unknown key outright, which is why
 * `.strict()` is on the object: an extra `pricePaid` in the tool call is a
 * refused call, not a silently dropped field.
 *
 * This is deliberately stronger than the pattern the other draft tools use.
 * `content_save_draft` and `proposal_save_draft` write things one person
 * reads; this writes the page a stranger reads, and a story that quotes what
 * a client paid is a breach of that client's confidence we could not take
 * back — the page is cached, scraped and archived within the hour.
 *
 * The tool cannot publish either: `status` is not in the input, so a saved
 * draft stays a draft. Going public is `case_study_publish`, which is
 * `requires_approval`.
 *
 * `screenshots` is absent for the same reason: the pictures are taken by the
 * worker with the PDF engine's browser and written straight onto the row, so
 * there is no way for a model to point the public page at an image it chose.
 */
export const caseStudySaveDraft = defineTool({
  name: "case_study_save_draft",
  description:
    "Save the story onto the case study as a draft. It stays a draft — publishing is a separate step Shoji approves. " +
    "Call once, after case_study_get_material. Anything not listed here cannot be saved: there are no fields for prices, " +
    "logins, suppliers, staff or internal notes.",
  input: z
    .object({
      caseStudyId: z.string().uuid().describe("The case study from the run's payload."),
      name: z.string().trim().min(1).max(300)
        .describe("What the build is called on the page, named for the client's business."),
      sector: z.string().trim().min(1).max(200)
        .describe("Two or three words: 'Taxi and private hire', 'Landscaping'."),
      summary: z.string().trim().min(1).max(300)
        .describe("One line for the card on the Work page. No full stop needed."),
      brief: z
        .object({
          client: z.string().trim().min(1).max(CASE_STUDY_SECTION_MAX_CHARS)
            .describe("Who they are and what they do. Their business, not ours."),
          problem: z.string().trim().min(1).max(CASE_STUDY_SECTION_MAX_CHARS)
            .describe("What was wrong before, in their words where the milestones give you them."),
          built: z.string().trim().min(1).max(CASE_STUDY_BUILT_MAX_CHARS)
            .describe("What we made. Concrete, from the milestones and the phases."),
          results: z.string().trim().min(1).max(CASE_STUDY_SECTION_MAX_CHARS)
            .describe("What changed for them. Only what the material states — never a made-up percentage."),
        })
        .strict(),
      stack: z.array(z.string().trim().min(1).max(120)).max(20).optional()
        .describe("The technologies on the page. Leave it out to keep what is already there."),
      year: z.number().int().min(1990).max(2200).optional()
        .describe("The year it went live, from the delivery date."),
      url: z.string().trim().url().max(500).optional()
        .describe("The live public address. Leave it out unless the material gives you one."),
    })
    .strict(),
  risk: "safe",
  execute: async (input, ctx): Promise<CaseStudySaveDraftResult> => {
    try {
      const before = await requireCaseStudy(ctx.db, ctx.organisationId, input.caseStudyId);
      // A published story is not a draft to overwrite. A re-run that found one
      // has nothing to do; saying so costs a turn and keeps the live page as
      // Shoji last approved it.
      if (before.status === "published" || before.status === "unlisted") {
        return { saved: false, caseStudyId: input.caseStudyId, reason: "That story is already live; edit it in the admin portal instead." };
      }
      const after = await updateCaseStudy(ctx.db, ctx.organisationId, {
        caseStudyId: input.caseStudyId,
        name: input.name,
        sector: input.sector,
        summary: input.summary,
        brief: input.brief,
        ...(input.stack ? { stack: input.stack } : {}),
        ...(input.year !== undefined ? { year: input.year } : {}),
        ...(input.url ? { url: input.url } : {}),
        actorKind: "agent",
        actorId: CASE_STUDY_WRITER_KEY,
      });
      return { saved: true, caseStudyId: after.id, slug: after.slug, status: after.status };
    } catch (error) {
      if (error instanceof CaseStudyRefused) {
        return { saved: false, caseStudyId: input.caseStudyId, reason: error.message };
      }
      throw error;
    }
  },
});
