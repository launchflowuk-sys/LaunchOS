import { ProposalRefused, createProposal, describePricing, listProposals } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";
import { PROPOSAL_DRAFTER_KEY, PROPOSAL_SUMMARY_MAX_CHARS } from "./proposal-shared.js";

const LineInput = z.object({
  kind: z.enum(["setup", "monthly", "one_off"]).describe(
    "Which part of the price this line is. A monthly_on_delivery proposal may carry only `monthly` lines; " +
    "a setup_plus_monthly one only `setup` and `monthly`; a one_off one only `one_off`.",
  ),
  description: z.string().trim().min(1).max(300).describe("What the client is paying for, in their words, e.g. 'Five-page website, designed and built'."),
  quantity: z.number().int().min(1).max(999).default(1),
  unitPence: z.number().int().min(0).max(10_000_000).describe("Pence, not pounds. £250 is 25000."),
});

const Input = z.object({
  leadId: z.string().uuid().optional().describe("The lead this quote is for. Give this or clientId."),
  clientId: z.string().uuid().optional().describe("The client this quote is for, when they are already on the books."),
  title: z.string().trim().min(1).max(300).describe("What the work is, named for them, e.g. 'Website and monthly care for Khan Dental'."),
  summary: z.string().trim().min(1).max(PROPOSAL_SUMMARY_MAX_CHARS).describe("Three or four sentences: what they asked for, what we will do, why it answers it."),
  shape: z.enum(["monthly_on_delivery", "setup_plus_monthly", "one_off"]).describe(
    "How they pay. monthly_on_delivery: nothing today, a monthly fee starting when the work goes live. " +
    "setup_plus_monthly: a fee to start, then a monthly fee. one_off: a single payment, nothing recurring.",
  ),
  packageSlug: z.string().trim().min(1).max(60).optional().describe("The retainer from packages_list this quote is built on, when it is one."),
  deliverables: z.array(z.string().trim().min(1).max(300)).min(1).max(30).describe("What they get, one line each. Only things LaunchFlow actually does."),
  outOfScope: z.array(z.string().trim().min(1).max(300)).max(30).default([]).describe("What this price does not cover — the sentence that stops an argument in month three."),
  timeline: z.string().trim().max(1000).default("").describe("How long the work takes in working weeks from the go-ahead. Never a calendar date the brief does not support."),
  terms: z.string().trim().max(20_000).optional().describe("Anything beyond the standard terms. Leave it out unless the brief needs it."),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD. Leave it out for the usual thirty days."),
  lines: z.array(LineInput).min(1).max(30).describe("The priced schedule. The totals come from these; there is no other way to price a proposal."),
});

export type ProposalSaveDraftResult =
  | { saved: true; proposalId: string; reference: string; priceSentence: string; dueOnAcceptancePence: number; recurringMonthlyPence: number }
  | { saved: false; reason: string; proposalId?: string };

/**
 * Writes the draft — nobody has seen it, so this is `safe`.
 *
 * Three things are enforced here rather than left to the prompt:
 *
 * 1. **The price comes from the lines and only from the lines.** There is no
 *    field on this tool for a total; `createProposal` sums the schedule and
 *    writes the amounts itself. A model that says "£1,200 to start" in the
 *    summary while the lines add up to £900 cannot make the document say the
 *    former, because the document reads the latter.
 * 2. **A line kind the shape does not allow is refused**, by `createProposal`,
 *    before anything is written — so a refusal costs the run a turn and not a
 *    half-written proposal.
 * 3. **One live draft per lead or client.** A run that saved and then called
 *    again gets the first proposal's id back rather than a second quote with
 *    a second reference number sitting in the list. Retrying a *refused* save
 *    is safe for the same reason as (2): a refusal writes nothing.
 *
 * Refusals come back as data rather than thrown, so the model can fix the
 * draft and try again instead of the whole run failing.
 */
export const proposalSaveDraft = defineTool({
  name: "proposal_save_draft",
  description:
    "Save the proposal as a draft: title, summary, scope, the priced schedule and how long it stands. Nobody sees it until it is approved. " +
    "The totals are worked out from `lines` — there is no field for a total, so price the work by listing it. " +
    "Returns { saved: false, reason } when a line does not fit the pricing shape or there is already a draft, so you can fix it and call again.",
  input: Input,
  risk: "safe",
  execute: async (input, ctx): Promise<ProposalSaveDraftResult> => {
    if (!input.leadId && !input.clientId) return { saved: false, reason: "Give leadId or clientId — a proposal has to be for somebody." };

    // One live draft per party. Checked before the write rather than relying
    // on the model to remember what it did earlier in the run.
    const existing = await listProposals(ctx.db, ctx.organisationId, {
      status: "draft",
      ...(input.leadId ? { leadId: input.leadId } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      limit: 1,
    });
    if (existing[0]) {
      return {
        saved: false,
        proposalId: existing[0].id,
        reason: `There is already a draft proposal (${existing[0].reference}) for them. Send that one for approval instead of writing another.`,
      };
    }

    let packageId: string | undefined;
    if (input.packageSlug) {
      const [pkg] = await ctx.db.select({ id: schema.packages.id }).from(schema.packages)
        .where(and(
          eq(schema.packages.organisationId, ctx.organisationId),
          eq(schema.packages.slug, input.packageSlug),
          eq(schema.packages.active, true),
          isNull(schema.packages.deletedAt),
        ));
      if (!pkg) return { saved: false, reason: `There is no active package with the slug "${input.packageSlug}". Call packages_list and use a slug from it, or leave it out.` };
      packageId = pkg.id;
    }

    try {
      const detail = await createProposal(ctx.db, ctx.organisationId, {
        ...(input.leadId ? { leadId: input.leadId } : {}),
        ...(input.clientId ? { clientId: input.clientId } : {}),
        title: input.title,
        summary: input.summary,
        scope: { deliverables: input.deliverables, outOfScope: input.outOfScope, timeline: input.timeline },
        pricing: { shape: input.shape, ...(packageId ? { packageId } : {}) },
        ...(input.terms ? { terms: input.terms } : {}),
        ...(input.validUntil ? { validUntil: input.validUntil } : {}),
        lines: input.lines,
        actorKind: "agent",
        actorId: PROPOSAL_DRAFTER_KEY,
        now: ctx.now(),
      });
      return {
        saved: true,
        proposalId: detail.proposal.id,
        reference: detail.proposal.reference,
        priceSentence: describePricing(detail.totals),
        dueOnAcceptancePence: detail.totals.dueOnAcceptancePence,
        recurringMonthlyPence: detail.totals.recurringMonthlyPence,
      };
    } catch (error) {
      if (error instanceof ProposalRefused) return { saved: false, reason: error.message };
      throw error;
    }
  },
});
