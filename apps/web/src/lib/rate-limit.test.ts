import { describe, expect, it } from "vitest";
import { clientAddress, RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit in a window, then refuses until it resets", () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect(limiter.allow("a", t0)).toBe(true);
    expect(limiter.allow("a", t0 + 1)).toBe(true);
    expect(limiter.allow("a", t0 + 2)).toBe(true);
    expect(limiter.allow("a", t0 + 3)).toBe(false);
    expect(limiter.retryAfterSeconds("a", t0 + 3)).toBe(60);
    // Another key has its own budget.
    expect(limiter.allow("b", t0 + 3)).toBe(true);
    expect(limiter.retryAfterSeconds("b", t0 + 3)).toBe(0);
    // The window rolls over.
    expect(limiter.allow("a", t0 + 60_000)).toBe(true);
    expect(limiter.retryAfterSeconds("a", t0 + 60_000)).toBe(0);
  });

  it("drops expired buckets once the map is large, so distinct callers cannot grow it forever", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 10 });
    for (let i = 0; i < 1200; i += 1) limiter.allow(`ip-${i}`, 0);
    // A hit after every window has expired sweeps the old ones away.
    limiter.allow("fresh", 1_000);
    expect(limiter["buckets"].size).toBe(1);
  });
});

describe("clientAddress", () => {
  it("takes the first x-forwarded-for entry, then x-real-ip, then a shared bucket", () => {
    const withForwarded = new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
    expect(clientAddress(withForwarded)).toBe("203.0.113.7");
    const withRealIp = new Request("http://localhost/", { headers: { "x-real-ip": "198.51.100.2" } });
    expect(clientAddress(withRealIp)).toBe("198.51.100.2");
    expect(clientAddress(new Request("http://localhost/"))).toBe("unknown");
  });
});
