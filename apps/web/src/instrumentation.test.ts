import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rule is pinned in `lib/env.test.ts`; what is pinned here is that the rule
 * *runs* — before the first request, from the one hook Next guarantees to call
 * once per server start. The failure this closes was a production web container
 * that booted clean on `EMAIL_ADAPTER=mock` because nothing had imported
 * `lib/env` yet.
 */

/**
 * Every variable `lib/env.ts` reads, so a case's environment is the fixture and
 * nothing else.
 *
 * The list used to stop at the adapter keys, which left `VAT_RATE`, `APP_URL`
 * and the three startup secrets coming from the developer's own `.env` —
 * `packages/config/vitest.shared.ts` dotenv-loads the repo root for every
 * package. Nothing bit while `.env.example` shipped valid values for all of
 * them; a blank `VAT_RATE=` failed this file at import with a VAT message.
 */
const KEYS = [
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "EMAIL_ADAPTER",
  "SMTP_HOST",
  "SMTP_PORT",
  "UPTIME_PROBE",
  "PAYMENTS_ADAPTER",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  // The hosting, DNS, CMS and ads keys the guard reads. A developer's shell can
  // carry a real COOLIFY_API_TOKEN (Shoji's does), and a token without its URL
  // is exactly the half-set pair production refuses — so the "every adapter is
  // real" case below was refused on an ambient variable until these were here.
  "ADS_ADAPTER",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "META_ADS_ACCESS_TOKEN",
  "META_ADS_APP_SECRET",
  "COOLIFY_API_URL",
  "COOLIFY_API_TOKEN",
  "HOSTINGER_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "SECRETS_ENCRYPTION_KEY",
  "ALLOW_MOCK_ADAPTERS",
  "VAT_RATE",
  "APP_URL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "INBOUND_EMAIL_SECRET",
] as const;

/** What every production case needs before the adapter rules are the question. */
const required = {
  DATABASE_URL: "postgres://launchos:launchos@localhost:5432/launchos",
  BETTER_AUTH_SECRET: "H0oXW4bkNq2Zt7RmJv9cAe1PyLs6DfUg3ThQnKxB5Vd8Mr",
  INBOUND_EMAIL_SECRET: "Rr7Kd2Nq9Xb4Lm6Ph1Ts8Vw3Zc5Jy0Ge",
  // Refused in production when unset or left on the local default: it is the
  // host in the portal link a client is emailed.
  APP_URL: "https://os.launchflow.test",
};

const saved = new Map<string, string | undefined>();

function set(values: Record<string, string | undefined>) {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

beforeEach(() => {
  for (const key of KEYS) saved.set(key, process.env[key]);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Every adapter resolving to a real one — the shape a real production web resource has. */
const realAdapters = {
  ...required,
  NODE_ENV: "production",
  NEXT_RUNTIME: "nodejs",
  EMAIL_ADAPTER: "smtp",
  // Part of "real": without it `createEmailAdapter` throws instead of building.
  SMTP_HOST: "smtp.launchflow.test",
  UPTIME_PROBE: "http",
  PAYMENTS_ADAPTER: "stripe",
  STRIPE_SECRET_KEY: "sk_live_1",
  STRIPE_WEBHOOK_SECRET: "whsec_1",
};

describe("web instrumentation", () => {
  it("refuses to finish booting a production server whose adapters resolve to mocks", async () => {
    set({ ...required, NODE_ENV: "production", NEXT_RUNTIME: "nodejs" });
    const { register } = await import("./instrumentation");
    // A throw from register() aborts the server start, which is the point: the
    // refusal is a container that does not come up, not a 500 on route five.
    await expect(register()).rejects.toThrow(/Refusing to start in production on mock adapters/);
  });

  it("names the offending variable, so the fix is the log line", async () => {
    set({ ...realAdapters, EMAIL_ADAPTER: "mock" });
    const { register } = await import("./instrumentation");
    await expect(register()).rejects.toThrow(/EMAIL_ADAPTER=mock is refused in production/);
  });

  it("boots a production server once every adapter is real", async () => {
    set(realAdapters);
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("does nothing on the edge runtime, which loads no adapters and sends no mail", async () => {
    set({ ...required, NODE_ENV: "production", NEXT_RUNTIME: "edge" });
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });
});
