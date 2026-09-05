import { describe, expect, it, vi } from "vitest";
import { describeNodeEnv, loadEnv, LOCAL_APP_URL, parseEnv } from "./env.js";

/** The minimum a worker needs before the cross-field rules are the question. */
const base = { DATABASE_URL: "postgres://user:pw@localhost:5432/launchos" } as NodeJS.ProcessEnv;

describe("worker env", () => {
  it("refuses to start on the default LLM with no ANTHROPIC_API_KEY", () => {
    // Without this the worker boots happily and every agent run fails at its
    // first LLM call — after the run row is inserted — so the only symptom is
    // a queue full of failed runs and a log nobody is reading.
    expect(() => parseEnv({ ...base })).toThrow(/ANTHROPIC_API_KEY is required when LLM=anthropic/);
    expect(() => parseEnv({ ...base, LLM: "anthropic" })).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("treats an empty ANTHROPIC_API_KEY as missing, the way .env.example leaves it", () => {
    expect(() => parseEnv({ ...base, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("starts on the default LLM once the key is set", () => {
    const env = parseEnv({ ...base, ANTHROPIC_API_KEY: "sk-test" });
    expect(env.LLM).toBe("anthropic");
    expect(env.AGENT_MODEL).toBe("claude-opus-5");
  });

  it("allows LLM=fake with no key outside production, which is how local work runs", () => {
    expect(parseEnv({ ...base, LLM: "fake" }).LLM).toBe("fake");
    expect(parseEnv({ ...base, LLM: "fake", NODE_ENV: "development" }).LLM).toBe("fake");
  });

  // The adapter rules below are a separate refusal that also fires under
  // NODE_ENV=production; opting out of them here keeps these two about the LLM.
  const fakeInProduction = {
    ...base, LLM: "fake", NODE_ENV: "production", APP_URL: "https://os.launchflow.test", ALLOW_MOCK_ADAPTERS: "1",
  };

  it("refuses LLM=fake in production, because the agents would answer from a stub", () => {
    expect(() => parseEnv(fakeInProduction)).toThrow(/LLM=fake is refused in production/);
  });

  it("allows LLM=fake in production only when ALLOW_FAKE_LLM says it was meant", () => {
    const env = parseEnv({ ...fakeInProduction, ALLOW_FAKE_LLM: "1" });
    expect(env.LLM).toBe("fake");
    // Anything but the exact opt-in is still a refusal.
    expect(() => parseEnv({ ...fakeInProduction, ALLOW_FAKE_LLM: "true" }))
      .toThrow(/LLM=fake is refused in production/);
  });

  /** The minimum a *production* worker needs before the adapter rules are satisfied. */
  const production = {
    ...base,
    ANTHROPIC_API_KEY: "sk-test",
    NODE_ENV: "production",
    // A real address, because the worker hands this to the agent registry as
    // `portalBaseUrl` and the local default is refused in production.
    APP_URL: "https://os.launchflow.test",
    EMAIL_ADAPTER: "smtp",
    // `createEmailAdapter` parses this and throws without it, so a worker that
    // has EMAIL_ADAPTER=smtp and nothing else is not a live worker.
    SMTP_HOST: "smtp.launchflow.test",
    UPTIME_PROBE: "http",
    PAYMENTS_ADAPTER: "stripe",
    STRIPE_SECRET_KEY: "sk_live_1",
    STRIPE_WEBHOOK_SECRET: "whsec_1",
  } as NodeJS.ProcessEnv;

  it("refuses a production worker whose email adapter is the mock", () => {
    // Worse than a missing key: the mock adapter succeeds, so every reply is
    // marked `sent` with a `mock-…` id and nothing anywhere says otherwise.
    expect(() => parseEnv({ ...production, EMAIL_ADAPTER: "mock" }))
      .toThrow(/EMAIL_ADAPTER=mock is refused in production/);
    expect(() => parseEnv({ ...production, EMAIL_ADAPTER: undefined }))
      .toThrow(/EMAIL_ADAPTER=mock is refused in production/);
  });

  it("refuses a production worker on a mock uptime probe or a half-configured Stripe", () => {
    expect(() => parseEnv({ ...production, UPTIME_PROBE: "mock" }))
      .toThrow(/UPTIME_PROBE=mock is refused in production/);
    expect(() => parseEnv({ ...production, STRIPE_WEBHOOK_SECRET: undefined }))
      .toThrow(/PAYMENTS_ADAPTER=stripe is not configured and falls back to the mock/);
  });

  it("starts a production worker once every adapter resolves to a real one", () => {
    expect(parseEnv(production).EMAIL_ADAPTER).toBe("smtp");
  });

  it("refuses EMAIL_ADAPTER=smtp that createEmailAdapter cannot build", () => {
    // Not a downgrade — `SmtpEnv.parse` throws — so the worker dies at boot
    // *after* passing a guard that printed `email: "smtp"`. The guard reads
    // SMTP_HOST off the parsed value, which is why `EnvShape` declares it.
    expect(() => parseEnv({ ...production, SMTP_HOST: undefined }))
      .toThrow(/SMTP_HOST is required when EMAIL_ADAPTER=smtp/);
    // An empty SMTP_HOST= is stripped by withoutEmptyStrings, so it is unset too.
    expect(() => parseEnv({ ...production, SMTP_HOST: "" }))
      .toThrow(/SMTP_HOST is required when EMAIL_ADAPTER=smtp/);
    expect(() => parseEnv({ ...production, SMTP_PORT: "nonsense" }))
      .toThrow(/SMTP_PORT=nonsense is not a positive whole number/);
    expect(parseEnv({ ...production, SMTP_PORT: "465" }).EMAIL_ADAPTER).toBe("smtp");
  });

  it("boots on a blank SMTP_PORT=, the way the factory now reads it", () => {
    // The divergence this closes: `withoutEmptyStrings` stripped the blank
    // before the guard saw it, so the guard printed `email: "smtp"` and said
    // nothing — and five lines later `createEmailAdapter(process.env)` was
    // handed the raw `""`, coerced it to 0 and killed the worker on a bare
    // `Invalid input` naming no variable. Both now mean "unset → 587".
    expect(parseEnv({ ...production, SMTP_PORT: "" }).EMAIL_ADAPTER).toBe("smtp");
  });

  it("leaves local and test environments on the mocks, which is how everything here runs", () => {
    expect(parseEnv({ ...base, ANTHROPIC_API_KEY: "sk-test" }).EMAIL_ADAPTER).toBe("mock");
    expect(parseEnv({ ...base, ANTHROPIC_API_KEY: "sk-test", NODE_ENV: "development" }).UPTIME_PROBE).toBe("mock");
  });

  // Review L1: `portalUrl()` used to fall back to the local default, so a
  // client could be emailed "sign in to the portal" pointing at their own
  // machine. The worker passes APP_URL to the agent registry as `portalBaseUrl`.
  describe("APP_URL in production", () => {
    it("refuses an unset APP_URL, and the local default set by hand", () => {
      const withoutAppUrl = { ...production } as Record<string, string | undefined>;
      delete withoutAppUrl["APP_URL"];
      expect(() => parseEnv(withoutAppUrl as NodeJS.ProcessEnv)).toThrow(/APP_URL is http:\/\/localhost:3000 in production/);
      expect(() => parseEnv({ ...production, APP_URL: LOCAL_APP_URL })).toThrow(/in production/);
      expect(() => parseEnv({ ...production, APP_URL: `${LOCAL_APP_URL}/` })).toThrow(/in production/);
    });

    it("accepts a real address, and leaves local workers on the default", () => {
      expect(parseEnv({ ...production, APP_URL: "https://os.launchflow.co.uk" }).APP_URL).toBe("https://os.launchflow.co.uk");
      expect(parseEnv({ ...base, ANTHROPIC_API_KEY: "sk-test" }).APP_URL).toBe(LOCAL_APP_URL);
    });
  });

  it("allows the mocks in production only when ALLOW_MOCK_ADAPTERS says it was meant", () => {
    const staging = {
      ...base, ANTHROPIC_API_KEY: "sk-test", NODE_ENV: "production",
      APP_URL: "https://staging.launchflow.test", ALLOW_MOCK_ADAPTERS: "1",
    };
    expect(parseEnv(staging).EMAIL_ADAPTER).toBe("mock");
    expect(() => parseEnv({ ...staging, ALLOW_MOCK_ADAPTERS: "true" })).toThrow(/refused in production/);
  });

  // Every rule above is keyed on NODE_ENV === "production", and Node does not
  // default NODE_ENV — so a worker deployed without it passes all of them by
  // not being production, which is indistinguishable in the log from passing
  // them on merit. That is the state `infra/Dockerfile.worker` shipped in.
  describe("NODE_ENV, said out loud", () => {
    it("warns loudly when NODE_ENV is unset, because the guards are then off", () => {
      const line = describeNodeEnv(undefined);
      expect(line.level).toBe("warn");
      expect(line.message).toMatch(/NODE_ENV unset: production guards are OFF/);
      // An empty NODE_ENV= is stripped by withoutEmptyStrings, so it is unset too.
      expect(describeNodeEnv(parseEnv({ ...base, ANTHROPIC_API_KEY: "sk-test", NODE_ENV: "" }).NODE_ENV).level)
        .toBe("warn");
    });

    it("names the environment when it is set", () => {
      expect(describeNodeEnv("production")).toEqual({ level: "info", message: "NODE_ENV=production" });
      expect(describeNodeEnv("development").level).toBe("info");
    });

    it("prints that line once, from loadEnv", () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const env = loadEnv({ ...production, ALLOW_FAKE_LLM: undefined } as NodeJS.ProcessEnv, logger);
      expect(env.NODE_ENV).toBe("production");
      expect(logger.info).toHaveBeenCalledWith("NODE_ENV=production");
      // The NODE_ENV line is not a warning here. What *is* warned about, once
      // each, are the four adapters production tolerates on their mocks — the
      // fixture sets none of their keys — with the consequence spelled out.
      const warnings = logger.warn.mock.calls.map(([message]) => String(message));
      expect(warnings).toHaveLength(4);
      expect(warnings.every((w) => /adapter is the MOCK \(/.test(w))).toBe(true);
      expect(warnings.join(" ")).toMatch(/hosting adapter is the MOCK \(COOLIFY_API_URL unset\)/);
      expect(warnings.join(" ")).not.toMatch(/NODE_ENV/);
      // Cached, so a second call neither re-parses nor re-logs.
      loadEnv({} as NodeJS.ProcessEnv, logger);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });
  });
});
