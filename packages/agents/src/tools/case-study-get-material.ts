import { caseStudyMaterial, type CaseStudyMaterial } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The read half of the writer's allow-list.
 *
 * `caseStudyMaterial` selects named columns off `case_studies` and `projects`
 * and nothing else — no proposal, no invoice, no subscription, no package, no
 * access entry, no secret, no task, no staff member. There is no code path
 * from this tool to any of those tables, which is a different and much
 * stronger statement than a prompt saying "do not mention the price".
 *
 * That matters because the Case Study Writer is the only agent in LaunchOS
 * whose output is meant to be read by strangers. Everything else an agent
 * writes goes to Shoji or to one client; this goes on the public Work page. A
 * prompt-level rule holds until the first oddly-worded input; a schema-level
 * one holds because the number simply is not in the room.
 *
 * Safe: read-only, tenancy-scoped, and every field in it is something the
 * client can already see on their own progress page.
 */
export const caseStudyGetMaterial = defineTool({
  name: "case_study_get_material",
  description:
    "Everything you are allowed to know about this build: the existing brief, the client's name and sector, the phases and " +
    "the client-visible milestones, the stack, the public URL, the screenshots, the year and the day it was delivered. " +
    "There is nothing else — no prices, no logins, no internal notes, no supplier or staff names — so write only from this.",
  input: z.object({
    caseStudyId: z.string().uuid().describe("The case study from the run's payload."),
  }),
  risk: "safe",
  execute: async ({ caseStudyId }, ctx): Promise<CaseStudyMaterial> =>
    caseStudyMaterial(ctx.db, ctx.organisationId, { caseStudyId }),
});
