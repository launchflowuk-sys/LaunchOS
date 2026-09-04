import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

/** A production web environment with every adapter resolving to a real one. */
const production = {
  NODE_ENV: "production",
  APP_URL: "https://os.launchflow.test",
  EMAIL_ADAPTER: "smtp",
  // `createEmailAdapter` parses this; EMAIL_ADAPTER=smtp without it throws.
  SMTP_HOST: "smtp.launchflow.test",
  UPTIME_PROBE: "http",
  PAYMENTS_ADAPTER: "stripe",
  STRIPE_SECRET_KEY: "sk_live_1",
  STRIPE_WEBHOOK_SECRET: "whsec_1",
} as NodeJS.ProcessEnv;

describe("web env", () => {
  it("refuses a blank VAT_RATE rather than invoicing at 0%", () => {
    expect(() => parseEnv({ NODE_ENV: "test", VAT_RATE: "" } as NodeJS.ProcessEnv)).toThrow(/VAT_RATE is set but empty/);
    expect(parseEnv({ NODE_ENV: "test", VAT_RATE: "5" } as NodeJS.ProcessEnv).VAT_RATE).toBe(5);
  });

  it("refuses a production web process whose adapters resolve to mocks", () => {
    // The web app resolves adapters too, and the mock succeeds — a deployment
    // where only the worker refuses would still look healthy from the outside.
    expect(() => parseEnv({ ...production, EMAIL_ADAPTER: "mock" }))
      .toThrow(/EMAIL_ADAPTER=mock is refused in production/);
    expect(() => parseEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv))
      .toThrow(/Refusing to start in production on mock adapters/);
  });

  it("starts a production web process once every adapter is real", () => {
    expect(parseEnv(production).APP_URL).toBe("https://os.launchflow.test");
  });

  it("leaves local and test environments on the mocks", () => {
    expect(parseEnv({} as NodeJS.ProcessEnv).APP_URL).toBe("http://localhost:3000");
    expect(parseEnv({ NODE_ENV: "development", EMAIL_ADAPTER: "mock" } as NodeJS.ProcessEnv).VAT_RATE).toBeUndefined();
  });

  it("does not refuse a `next build`, which imports this module long before the runtime env exists", () => {
    // NODE_ENV=production is set by `next build` itself; a build sends nothing.
    expect(parseEnv({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" } as NodeJS.ProcessEnv).APP_URL)
      .toBe("http://localhost:3000");
  });

  it("allows the mocks in production only when ALLOW_MOCK_ADAPTERS says it was meant", () => {
    const staging = { NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "1" } as NodeJS.ProcessEnv;
    expect(parseEnv(staging).APP_URL).toBe("http://localhost:3000");
    expect(() => parseEnv({ ...staging, ALLOW_MOCK_ADAPTERS: "true" })).toThrow(/refused in production/);
  });
});
