import { describe, expect, it } from "vitest";
import { totalUpcomingByCurrency, type UpcomingPayment } from "./upcoming-payments.js";

function row(over: Partial<UpcomingPayment> = {}): UpcomingPayment {
  return {
    subscriptionId: "s1", clientId: "c1", clientName: "Grays CabLine", packageName: "Growth",
    amountPence: 22000, currency: "GBP", dueAt: new Date("2026-10-01T00:00:00Z"),
    status: "active", daysUntil: 22, ...over,
  };
}

describe("totalUpcomingByCurrency", () => {
  it("adds up what is coming, per currency", () => {
    const total = totalUpcomingByCurrency([row(), row({ amountPence: 11000 })]);
    expect(total).toEqual({ GBP: 33000 });
  });

  it("never adds two currencies into one number", () => {
    // A single figure across currencies is a wrong figure, not a rounded one.
    const total = totalUpcomingByCurrency([row(), row({ currency: "USD", amountPence: 5000 })]);
    expect(total).toEqual({ GBP: 22000, USD: 5000 });
  });

  it("is empty rather than zero when nothing is due", () => {
    expect(totalUpcomingByCurrency([])).toEqual({});
  });
});
