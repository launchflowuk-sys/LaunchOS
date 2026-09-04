import { describe, expect, it } from "vitest";
import { assertProductionAdapters, describeAdapters, productionAdapterIssues, resolveAdapters, UNBUILDABLE } from "./adapter-guard.js";
import { createPaymentsAdapter } from "./payments/index.js";
import { createAdsAdapter } from "./ads/index.js";
import { createIntegrations } from "./index.js";
import { HttpUptimeProbe } from "./uptime/index.js";

/**
 * The real `createEmailAdapter`, loaded by path at run time.
 *
 * The other three factories are in this package and imported normally; the email
 * one is in `packages/channels`, and both packages are leaves (CLAUDE.md's
 * dependency rule). A `devDependency` added so that one test could import it
 * would be a package-level edge all the same, and a static relative import would
 * pull a file from outside this package's `rootDir` into its TypeScript program.
 * A URL import at run time has neither effect and still runs the actual factory
 * — which is the whole point of the block below. If `packages/channels` moves,
 * this line fails loudly rather than quietly stopping checking anything.
 */
const emailFactoryUrl = new URL("../../channels/src/email/factory.ts", import.meta.url).href;
const { createEmailAdapter } = (await import(/* @vite-ignore */ emailFactoryUrl)) as {
  createEmailAdapter: (env: NodeJS.ProcessEnv) => { readonly name: string };
};

/**
 * A production environment with every adapter genuinely live. `SMTP_HOST` is
 * part of that and not decoration: `createEmailAdapter` parses it, and without
 * it the factory throws rather than building anything.
 */
const live = {
  NODE_ENV: "production",
  EMAIL_ADAPTER: "smtp",
  SMTP_HOST: "smtp.launchflow.test",
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

describe("EMAIL_ADAPTER=smtp that cannot be built", () => {
  // The guard used to resolve email on the variable alone. `SmtpEnv.parse` then
  // threw inside `createEmailAdapter`, so a production process passed a guard
  // that printed `email: "smtp"` and died at the first send — in the web app,
  // one 500 per invoice and per "test email", with no boot failure to look at.
  it("is a third state, not the mock: the factory throws rather than downgrading", () => {
    const env = { ...live, SMTP_HOST: undefined };
    expect(describeAdapters(env).email).toBe(UNBUILDABLE);
    expect(() => assertProductionAdapters(env)).toThrow(/SMTP_HOST is required when EMAIL_ADAPTER=smtp/);
    // Not the silent-downgrade message: nothing was downgraded, and telling the
    // operator it fell back to the mock would be a different lie.
    expect(() => assertProductionAdapters(env)).not.toThrow(/falls back to the mock/);
  });

  it("names the port too, since `SMTP_PORT=` is the shape .env.example ships", () => {
    expect(() => assertProductionAdapters({ ...live, SMTP_HOST: "smtp.test", SMTP_PORT: "" }))
      .toThrow(/SMTP_PORT= is not a positive whole number/);
    expect(productionAdapterIssues({ ...live, SMTP_HOST: "smtp.test", SMTP_PORT: "587" })).toEqual([]);
  });

  it("is not covered by ALLOW_MOCK_ADAPTERS, which only ever meant `I meant the mocks`", () => {
    const optedOut = { ...live, SMTP_HOST: undefined, ALLOW_MOCK_ADAPTERS: "1" };
    expect(() => assertProductionAdapters(optedOut)).toThrow(/cannot be built/);
    // …and the opt-out still covers the mocks themselves, unchanged.
    expect(productionAdapterIssues({ NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "1" })).toEqual([]);
  });

  it("says nothing outside production, where a broken SMTP config is the developer's own business", () => {
    expect(productionAdapterIssues({ EMAIL_ADAPTER: "smtp" })).toEqual([]);
  });
});

/**
 * The mirror, proved against the real factories.
 *
 * This module exists because resolving must not construct an SMTP transport or
 * a Stripe client at boot — so it re-implements four selection rules by hand,
 * and a re-implementation drifts. Each case below runs the *actual* factory and
 * asserts the guard said the same thing, so a change to any factory that this
 * file does not follow fails here rather than in production.
 */
type Env = Record<string, string | undefined>;

function guard(env: Env, name: string): string {
  return resolveAdapters(env).find((adapter) => adapter.name === name)!.resolved;
}

/** What a factory does with this environment: the adapter's own name, or `UNBUILDABLE` if it throws. */
function built(make: (env: NodeJS.ProcessEnv) => { readonly name: string }, env: Env): string {
  try {
    return make(env as NodeJS.ProcessEnv).name;
  } catch {
    return UNBUILDABLE;
  }
}

describe("every guard rule against the factory it mirrors", () => {
  it.each([
    {},
    { EMAIL_ADAPTER: "mock" },
    { EMAIL_ADAPTER: "" },
    { EMAIL_ADAPTER: "SMTP" },
    { EMAIL_ADAPTER: "smtp " },
    { EMAIL_ADAPTER: "mock", SMTP_HOST: "smtp.test" },
    { EMAIL_ADAPTER: "smtp" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: " " },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_USER: "u", SMTP_PASS: "p" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "587" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "465" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: " 587 " },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "0" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "-25" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "587.5" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "not-a-port" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "1e3" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "9007199254740993" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", MAIL_FROM: undefined },
  ])("email: %o", (env) => {
    expect(guard(env, "email")).toBe(built(createEmailAdapter, env));
  });

  it.each([
    {},
    { PAYMENTS_ADAPTER: "mock" },
    { PAYMENTS_ADAPTER: "stripe" },
    { PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk_live_1" },
    { PAYMENTS_ADAPTER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_1" },
    { PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk_live_1", STRIPE_WEBHOOK_SECRET: "whsec_1" },
    { PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "whsec_1" },
    { PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk_live_1", STRIPE_WEBHOOK_SECRET: "" },
    { PAYMENTS_ADAPTER: "Stripe", STRIPE_SECRET_KEY: "sk_live_1", STRIPE_WEBHOOK_SECRET: "whsec_1" },
    { PAYMENTS_ADAPTER: "mock", STRIPE_SECRET_KEY: "sk_live_1", STRIPE_WEBHOOK_SECRET: "whsec_1" },
    // The two numbers the factory also reads, at their most hostile: neither
    // changes which adapter comes back, which is why the guard ignores them.
    { PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh", VAT_RATE: "nonsense", PAYMENT_TERMS_DAYS: "-1" },
    { VAT_RATE: "", PAYMENT_TERMS_DAYS: "" },
  ])("payments: %o", (env) => {
    expect(guard(env, "payments")).toBe(built(createPaymentsAdapter, env));
  });

  it.each([
    {},
    { ADS_ADAPTER: "mock" },
    { ADS_ADAPTER: "google" },
    { ADS_ADAPTER: "meta" },
    { ADS_ADAPTER: "" },
    { ADS_ADAPTER: "google", MOCK_ADS_DROP_FROM: "not-a-date" },
  ])("ads: %o", (env) => {
    // `resolved` is "mock" whatever was asked for; `requested` is what carries
    // the difference, and it is what the silent-downgrade refusal reads.
    expect(guard(env, "ads")).toBe(built(createAdsAdapter, env));
  });

  it.each([
    {},
    { UPTIME_PROBE: "mock" },
    { UPTIME_PROBE: "http" },
    { UPTIME_PROBE: "HTTP" },
    { UPTIME_PROBE: "" },
    { UPTIME_PROBE: "http", MOCK_DOWN_URLS: "https://a.test, https://b.test" },
    { UPTIME_PROBE: "mock", MOCK_DOWN_URLS: ",,, " },
  ])("uptime: %o", (env) => {
    const probe = createIntegrations(env as NodeJS.ProcessEnv).uptime;
    expect(guard(env, "uptime")).toBe(probe instanceof HttpUptimeProbe ? "http" : "mock");
  });

  it("hosting, dns and cms are mock-only by construction, and the guard says so", () => {
    const env = { ...live } as NodeJS.ProcessEnv;
    const integrations = createIntegrations(env);
    expect(guard(env, "hosting")).toBe("mock");
    expect(guard(env, "dns")).toBe("mock");
    expect(guard(env, "cms")).toBe("mock");
    // Nothing in the environment can turn any of the three into a real client
    // today; when one can, this fails and the guard grows a variable.
    expect(integrations.hosting.constructor.name).toMatch(/^Mock/);
    expect(integrations.dns.constructor.name).toMatch(/^Mock/);
    expect(integrations.cms.constructor.name).toMatch(/^Mock/);
  });
});
