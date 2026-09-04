import { describe, expect, it } from "vitest";
import { vatPresentation, vatRatePercent } from "./invoice-document";

describe("vatRatePercent", () => {
  it("recovers the rate the invoice was raised at", () => {
    expect(vatRatePercent(29900, 5980)).toBe(20);
    expect(vatRatePercent(10000, 1250)).toBe(12.5);
  });

  it("has no rate to show when nothing was charged", () => {
    expect(vatRatePercent(29900, 0)).toBeNull();
    expect(vatRatePercent(0, 0)).toBeNull();
  });
});

/**
 * One case per branch: the document must never print a VAT charge above a
 * claim that the supplier is not registered to make it.
 */
describe("vatPresentation", () => {
  it("registered, VAT charged: shows the rate and the registration number", () => {
    const vat = vatPresentation("GB123456789", 29900, 5980);
    expect(vat.showVat).toBe(true);
    expect(vat.vatLabel).toBe("VAT @ 20%");
    expect(vat.rateLabel).toBe("20%");
    expect(vat.registrationLine).toBe("VAT no. GB123456789");
  });

  it("registered, zero-rated: no VAT line, registration still stated", () => {
    const vat = vatPresentation("GB123456789", 29900, 0);
    expect(vat.showVat).toBe(false);
    expect(vat.registrationLine).toBe("VAT no. GB123456789");
  });

  it("unregistered, no VAT: says so, and prints no VAT line", () => {
    const vat = vatPresentation(null, 29900, 0);
    expect(vat.showVat).toBe(false);
    expect(vat.registrationLine).toBe("VAT not registered");
  });

  it("unregistered but the invoice carries VAT: names the state instead of contradicting itself", () => {
    const vat = vatPresentation(null, 29900, 5980);
    // The totals still have to add up, so the amount is shown...
    expect(vat.showVat).toBe(true);
    // ...but the document must not also claim the supplier is unregistered.
    expect(vat.registrationLine).not.toBe("VAT not registered");
    expect(vat.registrationLine).toMatch(/registration not on file/);
  });

  it("treats a whitespace-only VAT number as no registration", () => {
    expect(vatPresentation("   ", 29900, 0).registrationLine).toBe("VAT not registered");
  });
});
