import { schema } from "@launchos/db";
import type { ProposalLineKind, ProposalPricing, ProposalPricingShape } from "@launchos/db/schema";
import { z } from "zod";
import { ProposalRefused } from "./shared.js";

/**
 * The three pricing shapes, and the arithmetic that follows from each.
 *
 * This file is pure: no database, no clock, no environment. That is
 * deliberate, because it is the part of proposals that has to be *right*.
 * Every number a client reads, every Stripe Checkout that opens when they
 * accept, and every project that gets created afterwards is derived from
 * `shape` plus a list of integer-pence lines — so the rules live in one place,
 * are exhaustively tested, and refuse nonsense at the boundary rather than
 * letting it surface on somebody's screen.
 *
 * **Money is integer pence, everywhere.** `quantity * unitPence` on integers
 * is exact; the same sum in pounds as floats is £249.99000000000001, and the
 * one place that must never happen is the document a client signs.
 */

export const ProposalPricingShapeSchema = z.enum(schema.proposalPricingShapeEnum.enumValues);
export const ProposalLineKindSchema = z.enum(schema.proposalLineKindEnum.enumValues);

/**
 * Which line kinds each shape may carry. **The one place this is written
 * down** — the schema comment points here, `addLine` reads here, and a fourth
 * shape would be a compile error until it appeared here too.
 *
 * A `one_off` proposal with a monthly line is not a mistake we want to find
 * later; it is a promise nobody made. So it is refused when the line is added.
 */
export const LINE_KINDS_FOR_SHAPE: Record<ProposalPricingShape, readonly ProposalLineKind[]> = {
  monthly_on_delivery: ["monthly"],
  setup_plus_monthly: ["setup", "monthly"],
  one_off: ["one_off"],
};

/** How each shape reads in a sentence, for a card or a subject line. */
export const SHAPE_LABEL: Record<ProposalPricingShape, string> = {
  monthly_on_delivery: "Monthly, starting on delivery",
  setup_plus_monthly: "Setup fee, then monthly",
  one_off: "One-off",
};

/**
 * Ceilings, so a typo or a runaway loop is a refusal rather than a document.
 *
 * £100,000 on one line and £1,000,000 on a proposal are both far past anything
 * LaunchFlow quotes; they exist to keep `quantity * unitPence` inside a safe
 * integer with room to spare, and to make an extra two zeros a caught error.
 */
export const MAX_LINE_QUANTITY = 999;
export const MAX_UNIT_PENCE = 10_000_000;
export const MAX_PROPOSAL_PENCE = 100_000_000;

/** The default note under the figures. Neutral: the owner writes the real one. */
export const DEFAULT_VAT_NOTE = "All prices are in pounds sterling.";

export const PenceSchema = z.number().int("amounts are whole pence").min(0, "an amount cannot be negative").max(MAX_UNIT_PENCE);
export const QuantitySchema = z.number().int("a quantity is a whole number").min(1).max(MAX_LINE_QUANTITY);

/** Everything the maths needs from a line; the row has more, and none of it matters here. */
export interface PricedLine {
  kind: ProposalLineKind;
  quantity: number;
  unitPence: number;
}

/**
 * What the owner may set on `pricing` by hand.
 *
 * The three amounts are **not** here, and that is the point: the only way to
 * price a proposal is to add lines. A form that could set `monthlyPence` to
 * £250 while the lines said £300 would eventually do exactly that.
 */
export const ProposalPricingInput = z.object({
  shape: ProposalPricingShapeSchema,
  /** The retainer this price came from, so acceptance can put them on it. */
  packageId: z.string().uuid().optional(),
  vatNote: z.string().trim().max(300).default(DEFAULT_VAT_NOTE),
});
export type ProposalPricingInput = z.input<typeof ProposalPricingInput>;

/**
 * The stored shape, validated on the way back in.
 *
 * `superRefine` refuses an amount the shape does not allow — a
 * `monthly_on_delivery` with a setup fee is a contradiction whichever way it
 * got written. Nothing in `core` can produce one (the amounts are summed from
 * lines whose kinds are already constrained), so this catches a hand-edited
 * row or a future caller, not our own code.
 */
export const ProposalPricingSchema = z
  .object({
    shape: ProposalPricingShapeSchema,
    packageId: z.string().uuid().optional(),
    setupPence: PenceSchema.default(0),
    monthlyPence: PenceSchema.default(0),
    oneOffPence: PenceSchema.default(0),
    currency: z.literal("GBP").default("GBP"),
    vatNote: z.string().max(300).default(DEFAULT_VAT_NOTE),
  })
  .superRefine((pricing, ctx) => {
    const allowed = LINE_KINDS_FOR_SHAPE[pricing.shape];
    const amounts: readonly [ProposalLineKind, number][] = [
      ["setup", pricing.setupPence],
      ["monthly", pricing.monthlyPence],
      ["one_off", pricing.oneOffPence],
    ];
    for (const [kind, pence] of amounts) {
      if (pence > 0 && !allowed.includes(kind)) {
        ctx.addIssue({ code: "custom", path: [`${kind}Pence`], message: `a ${pricing.shape} proposal cannot carry a ${kind} amount` });
      }
    }
  });

/** What a proposal actually costs, read three ways. Every figure is pence. */
export interface ProposalTotals {
  shape: ProposalPricingShape;
  currency: "GBP";
  /** The build fee. Zero unless the shape is `setup_plus_monthly`. */
  setupPence: number;
  /** The retainer. Zero for `one_off`. */
  monthlyPence: number;
  /** The single charge. Zero unless the shape is `one_off`. */
  oneOffPence: number;
  /**
   * What the client owes the moment they accept — the number the Stripe
   * Checkout opens with, and zero for `monthly_on_delivery`, which is the
   * whole selling point of that shape: nothing to pay until it is live.
   */
  dueOnAcceptancePence: number;
  /** What recurs every month afterwards. */
  recurringMonthlyPence: number;
  /** Setup plus twelve months — the only figure that compares the three shapes. */
  firstYearPence: number;
}

/** `quantity × unitPence`. Both integers, so the product is exact. */
export function lineTotalPence(line: PricedLine): number {
  return line.quantity * line.unitPence;
}

/** Refuses a line kind the shape does not allow, at the boundary that adds it. */
export function assertLineKindAllowed(shape: ProposalPricingShape, kind: ProposalLineKind): void {
  if (!LINE_KINDS_FOR_SHAPE[shape].includes(kind)) {
    throw new ProposalRefused(
      "shape_mismatch",
      `A ${SHAPE_LABEL[shape].toLowerCase()} proposal has no ${kind === "one_off" ? "one-off" : kind} line — change the pricing shape first.`,
    );
  }
}

function sumOf(lines: readonly PricedLine[], kind: ProposalLineKind): number {
  return lines.reduce((total, line) => (line.kind === kind ? total + lineTotalPence(line) : total), 0);
}

/**
 * The totals for a shape and its lines.
 *
 * Lines of a kind the shape does not allow are refused before they are ever
 * stored, so they cannot reach here — but a shape changed under existing
 * lines could, which is why `changeProposalShape` refuses that too. This
 * function therefore trusts nothing and sums only the kinds the shape allows;
 * a stray line contributes nothing rather than silently inflating a total.
 */
export function proposalTotals(shape: ProposalPricingShape, lines: readonly PricedLine[]): ProposalTotals {
  const allowed = LINE_KINDS_FOR_SHAPE[shape];
  const counted = lines.filter((line) => allowed.includes(line.kind));
  const setupPence = sumOf(counted, "setup");
  const monthlyPence = sumOf(counted, "monthly");
  const oneOffPence = sumOf(counted, "one_off");

  const dueOnAcceptancePence = shape === "setup_plus_monthly" ? setupPence : shape === "one_off" ? oneOffPence : 0;
  const recurringMonthlyPence = shape === "one_off" ? 0 : monthlyPence;

  return {
    shape,
    currency: "GBP",
    setupPence,
    monthlyPence,
    oneOffPence,
    dueOnAcceptancePence,
    recurringMonthlyPence,
    firstYearPence: setupPence + oneOffPence + recurringMonthlyPence * 12,
  };
}

/** True when there is nothing to agree to. A proposal like this may not be sent. */
export function isPricedAtNothing(totals: ProposalTotals): boolean {
  return totals.firstYearPence === 0;
}

/**
 * The pricing to store, given the lines as they now are.
 *
 * Immutable: a new object every time, so a caller holding the old pricing
 * still holds what it read. Refuses a total past `MAX_PROPOSAL_PENCE` — a
 * proposal that large is a typo, and the refusal names the number so the
 * owner can see which zero is the spare one.
 */
export function pricingFromLines(pricing: ProposalPricing, lines: readonly PricedLine[]): ProposalPricing {
  const totals = proposalTotals(pricing.shape, lines);
  if (totals.firstYearPence > MAX_PROPOSAL_PENCE) {
    throw new ProposalRefused(
      "no_price",
      `${formatPence(totals.firstYearPence)} over the first year is past the ${formatPence(MAX_PROPOSAL_PENCE)} ceiling — check the figures.`,
    );
  }
  return {
    ...pricing,
    setupPence: totals.setupPence,
    monthlyPence: totals.monthlyPence,
    oneOffPence: totals.oneOffPence,
    currency: "GBP",
  };
}

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

/** `£1,250.00`. Pence in, pounds out, always two decimals. */
export function formatPence(pence: number): string {
  return GBP.format(pence / 100);
}

/**
 * The one line that tells a client what they are agreeing to pay.
 *
 * Written per shape rather than assembled from the amounts, because the
 * difference between the shapes is a promise about *when*, and a template that
 * only printed figures would lose it.
 */
export function describePricing(totals: ProposalTotals): string {
  switch (totals.shape) {
    case "monthly_on_delivery":
      return `${formatPence(totals.monthlyPence)} a month, starting when the work goes live. Nothing to pay today.`;
    case "setup_plus_monthly":
      return `${formatPence(totals.setupPence)} to start, then ${formatPence(totals.monthlyPence)} a month.`;
    case "one_off":
      return `${formatPence(totals.oneOffPence)}, one payment. Nothing recurring.`;
  }
}
