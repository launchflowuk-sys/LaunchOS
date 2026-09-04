import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rule is pinned in `lib/env.test.ts`; what is pinned here is that the rule
 * *runs* — before the first request, from the one hook Next guarantees to call
 * once per server start. The failure this closes was a production web container
 * that booted clean on `EMAIL_ADAPTER=mock` because nothing had imported
 * `lib/env` yet.
 */

const KEYS = [
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "EMAIL_ADAPTER",
  "UPTIME_PROBE",
  "PAYMENTS_ADAPTER",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ALLOW_MOCK_ADAPTERS",
] as const;

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
  NODE_ENV: "production",
  NEXT_RUNTIME: "nodejs",
  EMAIL_ADAPTER: "smtp",
  UPTIME_PROBE: "http",
  PAYMENTS_ADAPTER: "stripe",
  STRIPE_SECRET_KEY: "sk_live_1",
  STRIPE_WEBHOOK_SECRET: "whsec_1",
};

describe("web instrumentation", () => {
  it("refuses to finish booting a production server whose adapters resolve to mocks", async () => {
    set({ NODE_ENV: "production", NEXT_RUNTIME: "nodejs" });
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
    set({ NODE_ENV: "production", NEXT_RUNTIME: "edge" });
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });
});
