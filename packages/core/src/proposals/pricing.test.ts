import { describe, expect, it } from "vitest";
import type { ProposalPricingShape } from "@launchos/db/schema";
import {
  DEFAULT_VAT_NOTE,
  LINE_KINDS_FOR_SHAPE,
  MAX_PROPOSAL_PENCE,
  MAX_UNIT_PENCE,
  PenceSchema,
  ProposalPricingSchema,
  QuantitySchema,
  assertLineKindAllowed,
  describePricing,
  formatPence,
  isPricedAtNothing,
  lineTotalPence,
  pricingFromLines,
  proposalTotals,
  type PricedLine,
} from "./pricing.js";
import { ProposalRefused } from "./shared.js";

const SHAPES: readonly ProposalPricingShape[] = ["monthly_on_delivery", "setup_plus_monthly", "one_off"];

const line = (kind: PricedLine["kind"], unitPence: number, quantity = 1): PricedLine => ({ kind, quantity, unitPence });

describe("the three shapes", () => {
  it("names every shape's allowed line kinds, and nothing else", () => {
    expect(LINE_KINDS_FOR_SHAPE).toEqual({
      monthly_on_delivery: ["monthly"],
      setup_plus_monthly: ["setup", "monthly"],
      one_off: ["one_off"],
    });
    // Every shape in the enum has a row: a fourth shape cannot be added
    // without deciding what it may carry.
    for (const shape of SHAPES) expect(LINE_KINDS_FOR_SHAPE[shape]).toBeDefined();
  });

  it("refuses a line kind the shape does not allow, and says which shape", () => {
    expect(() => assertLineKindAllowed("one_off", "monthly")).toThrow(ProposalRefused);
    expect(() => assertLineKindAllowed("one_off", "monthly")).toThrow(/one-off proposal has no monthly line/);
    expect(() => assertLineKindAllowed("monthly_on_delivery", "setup")).toThrow(/no setup line/);
    expect(() => assertLineKindAllowed("monthly_on_delivery", "one_off")).toThrow(/no one-off line/);
    expect(() => assertLineKindAllowed("setup_plus_monthly", "one_off")).toThrow(/no one-off line/);
    // And allows the ones it does.
    expect(() => assertLineKindAllowed("setup_plus_monthly", "setup")).not.toThrow();
    expect(() => assertLineKindAllowed("setup_plus_monthly", "monthly")).not.toThrow();
    expect(() => assertLineKindAllowed("monthly_on_delivery", "monthly")).not.toThrow();
    expect(() => assertLineKindAllowed("one_off", "one_off")).not.toThrow();
  });

  it("refuses an amount the shape cannot carry, however it was written", () => {
    const base = { currency: "GBP" as const, vatNote: "", setupPence: 0, monthlyPence: 0, oneOffPence: 0 };
    expect(ProposalPricingSchema.safeParse({ ...base, shape: "monthly_on_delivery", setupPence: 50_000 }).success).toBe(false);
    expect(ProposalPricingSchema.safeParse({ ...base, shape: "monthly_on_delivery", oneOffPence: 50_000 }).success).toBe(false);
    expect(ProposalPricingSchema.safeParse({ ...base, shape: "setup_plus_monthly", oneOffPence: 1 }).success).toBe(false);
    expect(ProposalPricingSchema.safeParse({ ...base, shape: "one_off", monthlyPence: 1 }).success).toBe(false);
    expect(ProposalPricingSchema.safeParse({ ...base, shape: "one_off", setupPence: 1 }).success).toBe(false);
    // Zero is never an offence: it is the absence of that amount.
    expect(ProposalPricingSchema.safeParse({ ...base, shape: "one_off", oneOffPence: 120_000 }).success).toBe(true);
    expect(ProposalPricingSchema.safeParse({ ...base, shape: "setup_plus_monthly", setupPence: 1, monthlyPence: 1 }).success).toBe(true);
  });

  it("defaults currency and the VAT note, and refuses anything but sterling", () => {
    const parsed = ProposalPricingSchema.parse({ shape: "one_off", oneOffPence: 100 });
    expect(parsed).toMatchObject({ currency: "GBP", vatNote: DEFAULT_VAT_NOTE, setupPence: 0, monthlyPence: 0 });
    expect(ProposalPricingSchema.safeParse({ shape: "one_off", oneOffPence: 100, currency: "USD" }).success).toBe(false);
  });
});

describe("money", () => {
  it("only accepts whole, non-negative pence inside the ceilings", () => {
    expect(PenceSchema.safeParse(0).success).toBe(true);
    expect(PenceSchema.safeParse(24_999).success).toBe(true);
    expect(PenceSchema.safeParse(MAX_UNIT_PENCE).success).toBe(true);
    expect(PenceSchema.safeParse(MAX_UNIT_PENCE + 1).success).toBe(false);
    expect(PenceSchema.safeParse(-1).success).toBe(false);
    expect(PenceSchema.safeParse(24_999.5).success).toBe(false);
    expect(PenceSchema.safeParse(Number.NaN).success).toBe(false);
    expect(QuantitySchema.safeParse(0).success).toBe(false);
    expect(QuantitySchema.safeParse(1.5).success).toBe(false);
    expect(QuantitySchema.safeParse(999).success).toBe(true);
    expect(QuantitySchema.safeParse(1000).success).toBe(false);
  });

  it("multiplies exactly — the sum a float would round", () => {
    // 3 × £249.99 is £749.97, not £749.9700000000001.
    expect(lineTotalPence(line("one_off", 24_999, 3))).toBe(74_997);
    expect(lineTotalPence(line("monthly", 0, 999))).toBe(0);
    expect(lineTotalPence(line("setup", 1, 1))).toBe(1);
  });

  it("formats pence as sterling, always to two places", () => {
    expect(formatPence(0)).toBe("£0.00");
    expect(formatPence(1)).toBe("£0.01");
    expect(formatPence(25_000)).toBe("£250.00");
    expect(formatPence(125_000_0)).toBe("£12,500.00");
  });
});

describe("totals", () => {
  it("monthly on delivery: nothing due today, the retainer every month, twelve months in the first year", () => {
    const totals = proposalTotals("monthly_on_delivery", [line("monthly", 15_000), line("monthly", 10_000)]);
    expect(totals).toEqual({
      shape: "monthly_on_delivery",
      currency: "GBP",
      setupPence: 0,
      monthlyPence: 25_000,
      oneOffPence: 0,
      dueOnAcceptancePence: 0,
      recurringMonthlyPence: 25_000,
      firstYearPence: 300_000,
    });
  });

  it("setup plus monthly: the build fee is what Checkout opens with, and it counts once in the year", () => {
    const totals = proposalTotals("setup_plus_monthly", [line("setup", 120_000), line("monthly", 25_000)]);
    expect(totals).toEqual({
      shape: "setup_plus_monthly",
      currency: "GBP",
      setupPence: 120_000,
      monthlyPence: 25_000,
      oneOffPence: 0,
      dueOnAcceptancePence: 120_000,
      recurringMonthlyPence: 25_000,
      firstYearPence: 420_000,
    });
  });

  it("one off: the whole price is due on acceptance and nothing recurs", () => {
    const totals = proposalTotals("one_off", [line("one_off", 95_000), line("one_off", 5_000)]);
    expect(totals).toEqual({
      shape: "one_off",
      currency: "GBP",
      setupPence: 0,
      monthlyPence: 0,
      oneOffPence: 100_000,
      dueOnAcceptancePence: 100_000,
      recurringMonthlyPence: 0,
      firstYearPence: 100_000,
    });
  });

  it("counts quantities, and sums nothing from an empty proposal", () => {
    expect(proposalTotals("setup_plus_monthly", [line("setup", 30_000, 4)]).setupPence).toBe(120_000);
    const empty = proposalTotals("monthly_on_delivery", []);
    expect(empty.firstYearPence).toBe(0);
    expect(isPricedAtNothing(empty)).toBe(true);
    expect(isPricedAtNothing(proposalTotals("monthly_on_delivery", [line("monthly", 1)]))).toBe(false);
  });

  it("ignores a line the shape does not allow rather than inflating a total with it", () => {
    // Nothing can store such a line — `addProposalLine` refuses it — but a
    // shape changed under old rows must not quietly add a monthly charge to a
    // one-off price.
    const totals = proposalTotals("one_off", [line("one_off", 50_000), line("monthly", 25_000)]);
    expect(totals.oneOffPence).toBe(50_000);
    expect(totals.monthlyPence).toBe(0);
    expect(totals.firstYearPence).toBe(50_000);
  });

  it("never lets a shape produce an amount it does not allow, over every combination of lines", () => {
    const all = [line("setup", 1_000), line("monthly", 2_000), line("one_off", 3_000)];
    for (const shape of SHAPES) {
      const totals = proposalTotals(shape, all);
      const allowed = LINE_KINDS_FOR_SHAPE[shape];
      if (!allowed.includes("setup")) expect(totals.setupPence).toBe(0);
      if (!allowed.includes("monthly")) expect(totals.monthlyPence).toBe(0);
      if (!allowed.includes("one_off")) expect(totals.oneOffPence).toBe(0);
      // Whatever the shape, the stored figures must parse back.
      expect(ProposalPricingSchema.safeParse({ ...totals, vatNote: "" }).success).toBe(true);
    }
  });
});

describe("derived pricing", () => {
  const base = { shape: "setup_plus_monthly" as const, setupPence: 999, monthlyPence: 999, oneOffPence: 999, currency: "GBP" as const, vatNote: "No VAT" };

  it("rewrites the amounts from the lines and leaves everything else alone", () => {
    const next = pricingFromLines(base, [line("setup", 50_000), line("monthly", 20_000)]);
    expect(next).toEqual({ shape: "setup_plus_monthly", setupPence: 50_000, monthlyPence: 20_000, oneOffPence: 0, currency: "GBP", vatNote: "No VAT" });
  });

  it("returns a new object and does not touch the one it was given", () => {
    const next = pricingFromLines(base, [line("setup", 1)]);
    expect(next).not.toBe(base);
    expect(base.setupPence).toBe(999);
  });

  it("refuses a first-year total past the ceiling, and names the number", () => {
    const huge = [line("monthly", MAX_UNIT_PENCE, 2)];
    expect(() => pricingFromLines({ ...base, shape: "monthly_on_delivery" }, huge)).toThrow(ProposalRefused);
    expect(() => pricingFromLines({ ...base, shape: "monthly_on_delivery" }, huge)).toThrow(formatPence(MAX_PROPOSAL_PENCE));
  });
});

describe("how a price reads", () => {
  it("says when, not only how much — one sentence per shape", () => {
    expect(describePricing(proposalTotals("monthly_on_delivery", [line("monthly", 25_000)])))
      .toBe("£250.00 a month, starting when the work goes live. Nothing to pay today.");
    expect(describePricing(proposalTotals("setup_plus_monthly", [line("setup", 120_000), line("monthly", 25_000)])))
      .toBe("£1,200.00 to start, then £250.00 a month.");
    expect(describePricing(proposalTotals("one_off", [line("one_off", 95_000)])))
      .toBe("£950.00, one payment. Nothing recurring.");
  });
});
