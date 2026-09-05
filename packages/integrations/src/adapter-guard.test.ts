import { describe, expect, it } from "vitest";
import {
  assertProductionAdapters,
  describeAdapters,
  productionAdapterIssues,
  productionMockWarnings,
  resolveAdapters,
  UNBUILDABLE,
} from "./adapter-guard.js";
import { createPaymentsAdapter } from "./payments/index.js";
import { createAdsAdapterFromEnv } from "./ads/index.js";
import { createHostingProviderFromEnv } from "./coolify/index.js";
import { createDnsProvidersFromEnv } from "./dns/index.js";
import { createCmsProviderFromEnv } from "./cms/index.js";
import { createIntegrations } from "./index.js";
import { HttpUptimeProbe } from "./uptime/index.js";

/**
 * The real `createEmailAdapter`, loaded by path at run time.
 *
 * The other factories are in this package and imported normally; the email
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
 * A production environment with the three `refuse` adapters genuinely live and
 * nothing set for the four `log` ones — which is what production ran on the
 * day the real hosting, DNS, CMS and ads adapters landed. `SMTP_HOST` is part
 * of that and not decoration: `createEmailAdapter` parses it, and without it
 * the factory throws rather than building anything.
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

const GOOGLE = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_CLIENT_ID: "id",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "123-456-7890",
};
const META = { META_ADS_ACCESS_TOKEN: "EAAG", META_ADS_APP_SECRET: "app" };
const COOLIFY = { COOLIFY_API_URL: "https://coolify.launchflow.test", COOLIFY_API_TOKEN: "tok" };
const DNS = { HOSTINGER_API_TOKEN: "hpat_1", CLOUDFLARE_API_TOKEN: "cf_1" };
const CMS = { SECRETS_ENCRYPTION_KEY: "a".repeat(44) };

/** Every adapter real. */
const fullyLive = { ...live, ...GOOGLE, ...META, ...COOLIFY, ...DNS, ...CMS };

describe("adapter guard", () => {
  it("names what each factory will actually build", () => {
    expect(describeAdapters(live)).toEqual({
      email: "smtp", payments: "stripe", uptime: "http", ads: "mock", hosting: "mock", dns: "mock", cms: "mock",
    });
    expect(describeAdapters(fullyLive)).toEqual({
      email: "smtp", payments: "stripe", uptime: "http", ads: "google+meta", hosting: "coolify", dns: "hostinger+cloudflare", cms: "wordpress",
    });
    expect(describeAdapters({})).toEqual({
      email: "mock", payments: "mock", uptime: "mock", ads: "mock", hosting: "mock", dns: "mock", cms: "mock",
    });
  });

  it("leaves every non-production environment alone, which is how local work and the tests run", () => {
    expect(productionAdapterIssues({})).toEqual([]);
    expect(productionAdapterIssues({ NODE_ENV: "development" })).toEqual([]);
    expect(productionAdapterIssues({ NODE_ENV: "test", EMAIL_ADAPTER: "mock" })).toEqual([]);
    expect(productionMockWarnings({})).toEqual([]);
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
    // ADS_ADAPTER=google states an intent the credentials do not back.
    expect(() => assertProductionAdapters({ ...live, ADS_ADAPTER: "google" }))
      .toThrow(/ADS_ADAPTER=google is not configured and falls back to the mock/);
  });

  it("does not refuse ADS_ADAPTER=mock, and does not refuse the four newer adapters for being unset", () => {
    // Production ran with none of the hosting, DNS, CMS or ads keys set before
    // their real adapters existed, and it must keep booting after they land.
    expect(productionAdapterIssues({ ...live, ADS_ADAPTER: "mock" })).toEqual([]);
    expect(productionAdapterIssues(live)).toEqual([]);
  });

  it("warns, loudly and per adapter, about every mock a production process tolerates", () => {
    const warnings = productionMockWarnings(live);
    expect(warnings.map((w) => w.variable)).toEqual([
      "ADS_ADAPTER", "COOLIFY_API_URL", "HOSTINGER_API_TOKEN,CLOUDFLARE_API_TOKEN", "SECRETS_ENCRYPTION_KEY",
    ]);
    expect(warnings[1]!.message).toMatch(/hosting adapter is the MOCK \(COOLIFY_API_URL unset\)/);
    expect(warnings[1]!.message).toMatch(/Guard-Dog diagnoses from fiction/);
    // Nothing to warn about once everything is real.
    expect(productionMockWarnings(fullyLive)).toEqual([]);
    // The opt-out lets the refuse-class mocks through, and they are warned about too.
    const staging = { NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "1" };
    expect(productionMockWarnings(staging).map((w) => w.variable)).toContain("EMAIL_ADAPTER");
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

describe("hosting (Coolify)", () => {
  it("is real only when URL and token are both set", () => {
    expect(describeAdapters({ ...live, ...COOLIFY }).hosting).toBe("coolify");
    expect(productionAdapterIssues({ ...live, ...COOLIFY })).toEqual([]);
  });

  it("refuses a half-set pair as a silent downgrade, naming the missing half", () => {
    expect(() => assertProductionAdapters({ ...live, COOLIFY_API_URL: COOLIFY.COOLIFY_API_URL }))
      .toThrow(/COOLIFY_API_URL=coolify is not configured and falls back to the mock hosting adapter.*COOLIFY_API_TOKEN is not/);
    expect(() => assertProductionAdapters({ ...live, COOLIFY_API_TOKEN: "tok" }))
      .toThrow(/falls back to the mock hosting adapter.*COOLIFY_API_URL is not/);
    // The opt-out covers a downgrade, as it always has.
    expect(productionAdapterIssues({ ...live, COOLIFY_API_TOKEN: "tok", ALLOW_MOCK_ADAPTERS: "1" })).toEqual([]);
  });

  it("treats a malformed URL as UNBUILDABLE — the factory throws by design — and the opt-out does not cover it", () => {
    const bad = { ...live, ...COOLIFY, COOLIFY_API_URL: "coolify.launchflow.test" };
    expect(describeAdapters(bad).hosting).toBe(UNBUILDABLE);
    expect(() => assertProductionAdapters(bad)).toThrow(/COOLIFY_API_URL is not a valid URL/);
    expect(() => assertProductionAdapters({ ...bad, ALLOW_MOCK_ADAPTERS: "1" })).toThrow(/cannot be built/);
    const ftp = { ...live, ...COOLIFY, COOLIFY_API_URL: "ftp://coolify.launchflow.test" };
    expect(() => assertProductionAdapters(ftp)).toThrow(/must be http or https/);
  });

  it("reads a blank or whitespace variable as unset, exactly as the factory does", () => {
    expect(describeAdapters({ ...live, COOLIFY_API_URL: " ", COOLIFY_API_TOKEN: "" }).hosting).toBe("mock");
    expect(productionAdapterIssues({ ...live, COOLIFY_API_URL: " ", COOLIFY_API_TOKEN: "" })).toEqual([]);
  });
});

describe("dns (Hostinger + Cloudflare, per domain)", () => {
  it("reports the set of live halves and never refuses", () => {
    expect(describeAdapters({ ...live, HOSTINGER_API_TOKEN: "h" }).dns).toBe("hostinger");
    expect(describeAdapters({ ...live, CLOUDFLARE_API_TOKEN: "c" }).dns).toBe("cloudflare");
    expect(describeAdapters({ ...live, ...DNS }).dns).toBe("hostinger+cloudflare");
    expect(productionAdapterIssues({ ...live, HOSTINGER_API_TOKEN: "h" })).toEqual([]);
    // One token is a sound deployment, not a downgrade: the other half's zones
    // go to a mock the approval card names. It is still warned about.
    expect(productionMockWarnings({ ...live, HOSTINGER_API_TOKEN: "h" }).map((w) => w.variable)).not.toContain(
      "HOSTINGER_API_TOKEN,CLOUDFLARE_API_TOKEN",
    );
  });
});

describe("cms (WordPress)", () => {
  it("is real whenever the encryption key is set, and never UNBUILDABLE", () => {
    expect(describeAdapters({ ...live, ...CMS }).cms).toBe("wordpress");
    expect(describeAdapters({ ...live, SECRETS_ENCRYPTION_KEY: "not-a-real-key" }).cms).toBe("wordpress");
    expect(describeAdapters({ ...live, SECRETS_ENCRYPTION_KEY: "  " }).cms).toBe("mock");
    expect(productionAdapterIssues({ ...live, ...CMS })).toEqual([]);
  });
});

describe("ads (Google + Meta, by credential)", () => {
  it("is selected by credential, one platform at a time", () => {
    expect(describeAdapters({ ...live, ...GOOGLE }).ads).toBe("google");
    expect(describeAdapters({ ...live, ...META }).ads).toBe("meta");
    expect(describeAdapters({ ...live, ...GOOGLE, ...META }).ads).toBe("google+meta");
    expect(productionAdapterIssues({ ...live, ...GOOGLE })).toEqual([]);
    // ADS_ADAPTER=mock beside real credentials changes nothing: the factory does not read it.
    expect(describeAdapters({ ...live, ...GOOGLE, ADS_ADAPTER: "mock" }).ads).toBe("google");
  });

  it("refuses a half-set platform and names the missing keys", () => {
    const threeOfFive = { ...live, ...GOOGLE, GOOGLE_ADS_REFRESH_TOKEN: undefined, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "" };
    expect(describeAdapters(threeOfFive).ads).toBe("mock");
    expect(() => assertProductionAdapters(threeOfFive))
      .toThrow(/ADS_ADAPTER=google is not configured and falls back to the mock ads adapter.*Missing: GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID/);
    // Google complete, Meta half-set: the router is not built and Meta accounts
    // would read the mock series — partly configured, refused.
    const partly = { ...live, ...GOOGLE, META_ADS_ACCESS_TOKEN: "EAAG" };
    expect(describeAdapters(partly).ads).toBe("google");
    expect(() => assertProductionAdapters(partly))
      .toThrow(/ads adapter is partly configured: google\+meta was asked for but only google can be built.*Missing: META_ADS_APP_SECRET/);
    expect(productionAdapterIssues({ ...partly, ALLOW_MOCK_ADAPTERS: "1" })).toEqual([]);
  });

  it("honours ADS_ADAPTER as intent: naming a platform with no credentials is a refusal", () => {
    expect(() => assertProductionAdapters({ ...live, ADS_ADAPTER: "meta" }))
      .toThrow(/ADS_ADAPTER=meta is not configured.*Missing: META_ADS_ACCESS_TOKEN, META_ADS_APP_SECRET/);
    expect(productionAdapterIssues({ ...live, ...META, ADS_ADAPTER: "meta" })).toEqual([]);
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

  it("names a port that is set and wrong", () => {
    // `.env.example` ships `SMTP_PORT=587`; the shape that bites is a Coolify
    // variable typed by hand, which is why the message quotes the value back.
    expect(() => assertProductionAdapters({ ...live, SMTP_HOST: "smtp.test", SMTP_PORT: "smtp" }))
      .toThrow(/SMTP_PORT=smtp is not a positive whole number/);
    expect(productionAdapterIssues({ ...live, SMTP_HOST: "smtp.test", SMTP_PORT: "587" })).toEqual([]);
  });

  it("treats `SMTP_PORT=` — created and left blank — as unset, exactly as the factory does", () => {
    // The divergence this pair exists to stop: the worker strips blanks before
    // parsing, so the guard saw `undefined` and passed, while the factory was
    // handed the raw `process.env` and threw on `Number("") === 0` five lines
    // later. Both now read a blank variable as "unset → 587".
    const blankPort = { ...live, SMTP_HOST: "smtp.test", SMTP_PORT: "" };
    expect(describeAdapters(blankPort).email).toBe("smtp");
    expect(productionAdapterIssues(blankPort)).toEqual([]);
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
 * a Stripe client at boot — so it re-implements every selection rule by hand,
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

/** The adapters' own names, in the guard's vocabulary. */
const GUARD_NAME: Record<string, string> = {
  "mock-coolify": "mock",
  "mock-cms": "mock",
  "multi": "google+meta",
};
const named = (name: string): string => GUARD_NAME[name] ?? name;

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
    // The three blank shapes a Coolify variable created and never filled in
    // produces. Each must mean the same thing to the guard and to the factory.
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", SMTP_PORT: "", SMTP_USER: "", SMTP_PASS: "" },
    { EMAIL_ADAPTER: "smtp", SMTP_HOST: "", SMTP_PORT: "" },
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
    { ...GOOGLE },
    { ...GOOGLE, ADS_ADAPTER: "mock" },
    { ...GOOGLE, GOOGLE_ADS_CLIENT_SECRET: "" },
    { ...GOOGLE, GOOGLE_ADS_CLIENT_SECRET: "   " },
    { ...META },
    { META_ADS_ACCESS_TOKEN: "EAAG" },
    { ...GOOGLE, ...META },
    { ...GOOGLE, ...META, GOOGLE_ADS_API_VERSION: "v99", META_ADS_API_VERSION: "v99.0", META_ADS_CONVERSION_ACTIONS: "a,b" },
  ])("ads: %o", (env) => {
    // `resolved` is what the credentials allow; `requested` is what carries the
    // intent, and it is what the silent-downgrade refusal reads.
    expect(guard(env, "ads")).toBe(named(built(createAdsAdapterFromEnv, env)));
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

  it.each([
    {},
    { ...COOLIFY },
    { COOLIFY_API_URL: COOLIFY.COOLIFY_API_URL },
    { COOLIFY_API_TOKEN: "tok" },
    { COOLIFY_API_URL: "", COOLIFY_API_TOKEN: "" },
    { COOLIFY_API_URL: " ", COOLIFY_API_TOKEN: " " },
    { COOLIFY_API_URL: " https://coolify.launchflow.test ", COOLIFY_API_TOKEN: "tok" },
    { COOLIFY_API_URL: "https://coolify.launchflow.test/api/v1", COOLIFY_API_TOKEN: "tok" },
    { COOLIFY_API_URL: "coolify.launchflow.test", COOLIFY_API_TOKEN: "tok" },
    { COOLIFY_API_URL: "ftp://coolify.launchflow.test", COOLIFY_API_TOKEN: "tok" },
    { COOLIFY_API_URL: "coolify.launchflow.test" },
    { ...COOLIFY, COOLIFY_SERVER_UUID: "srv", COOLIFY_TIMEOUT_MS: "nonsense" },
  ])("hosting: %o", (env) => {
    expect(guard(env, "hosting")).toBe(named(built(createHostingProviderFromEnv, env)));
  });

  it.each([
    {},
    { ...DNS },
    { HOSTINGER_API_TOKEN: "h" },
    { CLOUDFLARE_API_TOKEN: "c" },
    { HOSTINGER_API_TOKEN: "", CLOUDFLARE_API_TOKEN: " " },
    { HOSTINGER_API_TOKEN: " h ", CLOUDFLARE_API_TOKEN: "" },
  ])("dns: %o", (env) => {
    // The registry's own name is `dns-registry`; what the guard reports is the
    // set of halves that will really answer, read off `for()`.
    const registry = createDnsProvidersFromEnv(env);
    const live = (["hostinger", "cloudflare"] as const).filter((key) => registry.for(key).name === key);
    expect(guard(env, "dns")).toBe(live.length > 0 ? live.join("+") : "mock");
  });

  it.each([
    {},
    { ...CMS },
    { SECRETS_ENCRYPTION_KEY: "" },
    { SECRETS_ENCRYPTION_KEY: "   " },
    { SECRETS_ENCRYPTION_KEY: "short" },
  ])("cms: %o", (env) => {
    expect(guard(env, "cms")).toBe(named(built(createCmsProviderFromEnv, env)));
  });

  it("createIntegrations builds what the guard names, mocks and real alike", () => {
    const mocks = createIntegrations({} as NodeJS.ProcessEnv);
    expect(mocks.hosting.name).toBe("mock-coolify");
    expect(mocks.dns.for?.("hostinger")?.name).toBe("mock-hostinger");
    expect(mocks.dns.for?.("cloudflare")?.name).toBe("mock-cloudflare");
    expect(mocks.cms.name).toBe("mock-cms");
    expect(mocks.ads.name).toBe("mock");

    const real = createIntegrations(fullyLive as NodeJS.ProcessEnv);
    expect(real.hosting.name).toBe("coolify");
    expect(real.dns.for?.("hostinger")?.name).toBe("hostinger");
    expect(real.dns.for?.("cloudflare")?.name).toBe("cloudflare");
    expect(real.cms.name).toBe("wordpress");
    expect(real.ads.name).toBe("multi");
  });

  it("a real CMS provider built without a credential resolver refuses rather than pretending", async () => {
    // `createIntegrations(env)` with no deps — the agent catalogue, the tests —
    // still gets the WordPress provider when the key is set, and that provider
    // must fail loudly on use, not report a page updated that it never touched.
    const cms = createIntegrations({ ...CMS } as NodeJS.ProcessEnv).cms;
    expect(cms.name).toBe("wordpress");
    const result = await cms.testConnection({ siteId: "11111111-1111-4111-8111-111111111111" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no WordPress connection/);
  });
});
