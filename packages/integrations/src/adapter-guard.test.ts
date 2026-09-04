import { describe, expect, it } from "vitest";
import { assertProductionAdapters, describeAdapters, productionAdapterIssues } from "./adapter-guard.js";

const live = {
  NODE_ENV: "production",
  EMAIL_ADAPTER: "smtp",
  UPTIME_PROBE: "http",
  PAYMENTS_ADAPTER: "stripe",
  STRIPE_SECRET_KEY: "sk_live_1",
  STRIPE_WEBHOOK_SECRET: "whsec_1",
};

describe("adapter guard", () => {
  it("names what each factory will actually build", () => {
    expect(describeAdapters(live)).toEqual({
      email: "smtp", payments: "stripe", uptime: "http", ads: "mock", hosting: "mock", dns: "mock", cms: "mock",
    });
    expect(describeAdapters({})).toMatchObject({ email: "mock", payments: "mock", uptime: "mock" });
  });

  it("leaves every non-production environment alone, which is how local work and the tests run", () => {
    expect(productionAdapterIssues({})).toEqual([]);
    expect(productionAdapterIssues({ NODE_ENV: "development" })).toEqual([]);
    expect(productionAdapterIssues({ NODE_ENV: "test", EMAIL_ADAPTER: "mock" })).toEqual([]);
  });

  it("refuses a production process whose email adapter is the mock", () => {
    // The sharp one: the mock *succeeds*, so every reply is marked sent and
    // nothing downstream ever shows a failure.
    expect(() => assertProductionAdapters({ ...live, EMAIL_ADAPTER: "mock" }))
      .toThrow(/EMAIL_ADAPTER=mock is refused in production/);
    expect(() => assertProductionAdapters({ ...live, EMAIL_ADAPTER: undefined }))
      .toThrow(/EMAIL_ADAPTER=mock is refused in production/);
  });

  it("refuses a mock uptime probe and a mock payments adapter too", () => {
    expect(() => assertProductionAdapters({ ...live, UPTIME_PROBE: "mock" }))
      .toThrow(/UPTIME_PROBE=mock is refused in production/);
    expect(() => assertProductionAdapters({ ...live, PAYMENTS_ADAPTER: "mock" }))
      .toThrow(/PAYMENTS_ADAPTER=mock is refused in production/);
  });

  it("refuses a silent downgrade — the environment asked for a real adapter and got the mock", () => {
    // Half-set Stripe builds the mock (payments/index.ts), so production must
    // not boot believing it is live.
    const halfStripe = { ...live, STRIPE_WEBHOOK_SECRET: undefined };
    expect(() => assertProductionAdapters(halfStripe))
      .toThrow(/PAYMENTS_ADAPTER=stripe is not configured and falls back to the mock/);
    // ADS_ADAPTER=google is accepted by the schema but still returns the mock.
    expect(() => assertProductionAdapters({ ...live, ADS_ADAPTER: "google" }))
      .toThrow(/ADS_ADAPTER=google is not configured and falls back to the mock/);
  });

  it("does not refuse ADS_ADAPTER=mock, which is the only wired option today", () => {
    expect(productionAdapterIssues({ ...live, ADS_ADAPTER: "mock" })).toEqual([]);
    expect(productionAdapterIssues(live)).toEqual([]);
  });

  it("reports every refusal at once rather than one per restart", () => {
    const issues = productionAdapterIssues({ NODE_ENV: "production" });
    expect(issues.map((i) => i.variable)).toEqual(["EMAIL_ADAPTER", "PAYMENTS_ADAPTER", "UPTIME_PROBE"]);
  });

  it("allows the mocks in production only when ALLOW_MOCK_ADAPTERS says it was meant", () => {
    const staging = { NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "1" };
    expect(assertProductionAdapters(staging)).toMatchObject({ email: "mock" });
    // Anything but the exact opt-in is still a refusal.
    expect(() => assertProductionAdapters({ NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "true" }))
      .toThrow(/refused in production/);
  });
});
