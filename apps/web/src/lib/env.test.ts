import { describe, expect, it } from "vitest";
import { MIN_AUTH_SECRET_LENGTH, parseEnv } from "./env";

/**
 * A secret of the shape `openssl rand -base64 48` produces, long enough to
 * clear the floor and not one of the published placeholders.
 */
const SECRET = "H0oXW4bkNq2Zt7RmJv9cAe1PyLs6DfUg3ThQnKxB5Vd8Mr";

/** The two the process refuses to start without; every case below needs them. */
const required = {
  // `next typegen` makes NODE_ENV required on ProcessEnv, so every fixture
  // carries one; the cases that care about it override it.
  NODE_ENV: "test",
  DATABASE_URL: "postgres://launchos:launchos@localhost:5432/launchos",
  BETTER_AUTH_SECRET: SECRET,
} as NodeJS.ProcessEnv;

/** A production web environment with every adapter resolving to a real one. */
const production = {
  ...required,
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
    expect(() => parseEnv({ ...required, NODE_ENV: "test", VAT_RATE: "" } as NodeJS.ProcessEnv)).toThrow(/VAT_RATE is set but empty/);
    expect(parseEnv({ ...required, NODE_ENV: "test", VAT_RATE: "5" } as NodeJS.ProcessEnv).VAT_RATE).toBe(5);
  });

  it("refuses a production web process whose adapters resolve to mocks", () => {
    // The web app resolves adapters too, and the mock succeeds — a deployment
    // where only the worker refuses would still look healthy from the outside.
    expect(() => parseEnv({ ...production, EMAIL_ADAPTER: "mock" }))
      .toThrow(/EMAIL_ADAPTER=mock is refused in production/);
    expect(() => parseEnv({ ...required, NODE_ENV: "production" } as NodeJS.ProcessEnv))
      .toThrow(/Refusing to start in production on mock adapters/);
  });

  it("starts a production web process once every adapter is real", () => {
    expect(parseEnv(production).APP_URL).toBe("https://os.launchflow.test");
  });

  it("leaves local and test environments on the mocks", () => {
    expect(parseEnv(required).APP_URL).toBe("http://localhost:3000");
    expect(parseEnv({ ...required, NODE_ENV: "development", EMAIL_ADAPTER: "mock" } as NodeJS.ProcessEnv).VAT_RATE).toBeUndefined();
  });

  it("does not refuse a `next build`, which imports this module long before the runtime env exists", () => {
    // NODE_ENV=production is set by `next build` itself; a build sends nothing,
    // signs no cookie and opens no connection, so neither the adapter rule nor
    // the secret rules apply to it.
    expect(parseEnv({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" } as NodeJS.ProcessEnv).APP_URL)
      .toBe("http://localhost:3000");
  });

  it("allows the mocks in production only when ALLOW_MOCK_ADAPTERS says it was meant", () => {
    const staging = { ...required, NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "1" } as NodeJS.ProcessEnv;
    expect(parseEnv(staging).APP_URL).toBe("http://localhost:3000");
    expect(() => parseEnv({ ...staging, ALLOW_MOCK_ADAPTERS: "true" })).toThrow(/refused in production/);
  });

  // The design spec asks for exactly this: "the process refuses to start
  // without DATABASE_URL and BETTER_AUTH_SECRET". Before these, a container
  // missing either one booted, passed /api/health, and failed on the first
  // sign-in — the worst moment and the wrong place.
  describe("the two secrets it refuses to start without", () => {
    it("refuses a missing or empty DATABASE_URL", () => {
      expect(() => parseEnv({ NODE_ENV: "test", BETTER_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL: not set/);
      expect(() => parseEnv({ ...required, DATABASE_URL: "  " } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL: not set/);
    });

    it("refuses a DATABASE_URL that is not a connection URL", () => {
      expect(() => parseEnv({ ...required, DATABASE_URL: "launchos" } as NodeJS.ProcessEnv))
        .toThrow(/DATABASE_URL: not a connection URL/);
    });

    it("refuses a missing BETTER_AUTH_SECRET", () => {
      expect(() => parseEnv({ NODE_ENV: "test", DATABASE_URL: required.DATABASE_URL } as NodeJS.ProcessEnv))
        .toThrow(/BETTER_AUTH_SECRET: not set/);
    });

    it("refuses the placeholder published in this repository", () => {
      // `.env.example` shipped `BETTER_AUTH_SECRET=change-me`, so a
      // `cp .env.example .env` deployment signed every session cookie with a
      // value in the public repo — session forgery for any account.
      expect(() => parseEnv({ ...required, BETTER_AUTH_SECRET: "change-me" } as NodeJS.ProcessEnv))
        .toThrow(/published in this repository/);
      // Padded to clear the length floor, so only the value check catches it.
      expect(() => parseEnv({ ...required, BETTER_AUTH_SECRET: "  Change-Me  " } as NodeJS.ProcessEnv))
        .toThrow(/published in this repository/);
      // And the published passwords, through `isPublishedDefaultPassword`.
      expect(() => parseEnv({ ...required, BETTER_AUTH_SECRET: "change-me-now" } as NodeJS.ProcessEnv))
        .toThrow(/published in this repository/);
    });

    it("refuses a secret under the length floor", () => {
      const short = "a".repeat(MIN_AUTH_SECRET_LENGTH - 1);
      expect(() => parseEnv({ ...required, BETTER_AUTH_SECRET: short } as NodeJS.ProcessEnv))
        .toThrow(new RegExp(`BETTER_AUTH_SECRET: ${MIN_AUTH_SECRET_LENGTH - 1} characters`));
      expect(parseEnv({ ...required, BETTER_AUTH_SECRET: "a".repeat(MIN_AUTH_SECRET_LENGTH) } as NodeJS.ProcessEnv).APP_URL)
        .toBe("http://localhost:3000");
    });

    it("reports both secrets at once rather than one per restart", () => {
      expect(() => parseEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL: not set[\s\S]*BETTER_AUTH_SECRET: not set/);
    });
  });
});
