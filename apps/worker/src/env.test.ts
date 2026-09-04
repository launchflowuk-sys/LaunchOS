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

  it("refuses LLM=fake in production, because the agents would answer from a stub", () => {
    expect(() => parseEnv({ ...base, LLM: "fake", NODE_ENV: "production" })).toThrow(/LLM=fake is refused in production/);
  });

  it("allows LLM=fake in production only when ALLOW_FAKE_LLM says it was meant", () => {
    const env = parseEnv({ ...base, LLM: "fake", NODE_ENV: "production", ALLOW_FAKE_LLM: "1" });
    expect(env.LLM).toBe("fake");
    // Anything but the exact opt-in is still a refusal.
    expect(() => parseEnv({ ...base, LLM: "fake", NODE_ENV: "production", ALLOW_FAKE_LLM: "true" }))
      .toThrow(/LLM=fake is refused in production/);
  });
});
