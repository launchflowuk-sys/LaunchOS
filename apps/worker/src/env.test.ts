import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

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
  const fakeInProduction = { ...base, LLM: "fake", NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "1" };

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
    EMAIL_ADAPTER: "smtp",
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

  it("leaves local and test environments on the mocks, which is how everything here runs", () => {
    expect(parseEnv({ ...base, ANTHROPIC_API_KEY: "sk-test" }).EMAIL_ADAPTER).toBe("mock");
    expect(parseEnv({ ...base, ANTHROPIC_API_KEY: "sk-test", NODE_ENV: "development" }).UPTIME_PROBE).toBe("mock");
  });

  it("allows the mocks in production only when ALLOW_MOCK_ADAPTERS says it was meant", () => {
    const staging = { ...base, ANTHROPIC_API_KEY: "sk-test", NODE_ENV: "production", ALLOW_MOCK_ADAPTERS: "1" };
    expect(parseEnv(staging).EMAIL_ADAPTER).toBe("mock");
    expect(() => parseEnv({ ...staging, ALLOW_MOCK_ADAPTERS: "true" })).toThrow(/refused in production/);
  });
});
