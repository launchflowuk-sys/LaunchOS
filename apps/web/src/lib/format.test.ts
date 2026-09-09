import { describe, expect, it } from "vitest";
import { formatMoney, formatPence } from "./format";

describe("formatMoney", () => {
  it("formats a well-formed code in the usual way", () => {
    expect(formatMoney(123_400, "GBP")).toBe("£1,234.00");
    expect(formatMoney(0, "GBP")).toBe("£0.00");
  });

  it("accepts a code in any case, with padding", () => {
    expect(formatMoney(100, " gbp ")).toBe("£1.00");
  });

  it("never throws on a malformed code — one bad row must not 500 a whole listing", () => {
    // `Intl.NumberFormat` raises RangeError for each of these, which is what
    // used to take /ads down for every account once one row held a typo.
    for (const bad of ["12X", "G B", "£$€", "", "GB"]) {
      expect(() => formatMoney(123_400, bad)).not.toThrow();
    }
    expect(formatMoney(123_400, "12X")).toBe("12X 1234.00");
    expect(formatMoney(50, "")).toBe("? 0.50");
  });

  it("renders an unknown but well-formed code rather than refusing it", () => {
    expect(formatMoney(100, "ZZZ")).toContain("1.00");
  });

  it("is what formatPence delegates to, defaulting to sterling", () => {
    expect(formatPence(1_000)).toBe("£10.00");
    expect(formatPence(1_000, "12X")).toBe("12X 10.00");
  });
});
