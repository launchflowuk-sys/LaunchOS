import { describe, expect, it } from "vitest";
import {
  convert,
  grossFromNet,
  monthlyMinor,
  netFromStored,
  yearlyMinor,
  type CostLike,
} from "./normalise.js";

const cost = (over: Partial<CostLike> = {}): CostLike => ({
  renewalPrice: 1200,
  currencyCode: "GBP",
  billingPeriod: 1,
  billingPeriodUnit: "month",
  vatTreatment: "none",
  status: "active",
  ...over,
});

describe("monthlyMinor", () => {
  it("passes a monthly cost straight through", () => {
    expect(monthlyMinor(cost())).toBe(1200);
  });

  it("spreads a yearly cost across twelve months", () => {
    expect(monthlyMinor(cost({ renewalPrice: 12_000, billingPeriodUnit: "year" }))).toBe(1000);
  });

  it("spreads a two-year term across twenty-four months", () => {
    expect(monthlyMinor(cost({ renewalPrice: 24_000, billingPeriod: 2, billingPeriodUnit: "year" }))).toBe(1000);
  });

  it("handles quarterly and weekly and daily terms", () => {
    expect(monthlyMinor(cost({ renewalPrice: 300, billingPeriod: 3, billingPeriodUnit: "month" }))).toBe(100);
    // A week is not a twelfth of anything; 52/12 weeks a month.
    expect(monthlyMinor(cost({ renewalPrice: 1000, billingPeriodUnit: "week" }))).toBe(4333);
    // 365/12 = 30.4166 days a month, so 100/day is 3041.67 rounded to 3042.
    expect(monthlyMinor(cost({ renewalPrice: 100, billingPeriodUnit: "day" }))).toBe(3042);
  });

  it("is zero for a cancelled subscription, which is not a forward cost", () => {
    expect(monthlyMinor(cost({ status: "cancelled" }))).toBe(0);
  });

  it("counts a trial, because a trial that renews is a charge nobody planned", () => {
    expect(monthlyMinor(cost({ status: "in_trial" }))).toBe(1200);
  });

  it("is zero rather than NaN for a nonsense period", () => {
    expect(monthlyMinor(cost({ billingPeriod: 0 }))).toBe(0);
    expect(monthlyMinor(cost({ billingPeriodUnit: "fortnight" }))).toBe(0);
  });
});

describe("yearlyMinor", () => {
  it("is twelve months of the monthly figure", () => {
    expect(yearlyMinor(cost({ renewalPrice: 1000 }))).toBe(12_000);
  });

  it("returns a yearly cost unchanged rather than round-tripping a rounding error", () => {
    // 12_001 / 12 does not divide; the yearly figure must still be 12_001.
    expect(yearlyMinor(cost({ renewalPrice: 12_001, billingPeriodUnit: "year" }))).toBe(12_001);
  });
});

describe("netFromStored and grossFromNet", () => {
  it("treats a standard-rated amount as net, with VAT on top", () => {
    // The register holds what the supplier charges before VAT.
    expect(netFromStored(1000, "standard")).toBe(1000);
    expect(grossFromNet(1000, "standard", 20)).toBe(1200);
  });

  it("makes gross equal net under the reverse charge, where no VAT is paid", () => {
    expect(netFromStored(1000, "reverse_charge")).toBe(1000);
    expect(grossFromNet(1000, "reverse_charge", 20)).toBe(1000);
  });

  it("makes gross equal net when exempt or not applicable", () => {
    expect(grossFromNet(1000, "exempt", 20)).toBe(1000);
    expect(grossFromNet(1000, "none", 20)).toBe(1000);
  });

  it("rounds VAT to the penny rather than carrying a fraction", () => {
    expect(grossFromNet(999, "standard", 20)).toBe(1199);
  });
});

describe("convert", () => {
  it("returns the amount untouched when the currency already matches", () => {
    expect(convert(1000, "GBP", "GBP", 0)).toBe(1000);
  });

  it("applies a micro-denominated rate", () => {
    // $10.00 at 0.7850 => £7.85
    expect(convert(1000, "USD", "GBP", 785_000)).toBe(785);
  });

  it("rounds to the nearest minor unit", () => {
    expect(convert(333, "USD", "GBP", 785_000)).toBe(261);
  });

  it("refuses to guess when no rate is known", () => {
    expect(() => convert(1000, "USD", "GBP", 0)).toThrow(/no rate/i);
  });
});
