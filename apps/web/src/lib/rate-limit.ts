/**
 * A fixed-window counter per key, in memory.
 *
 * Enough for the one unauthenticated write this app accepts — the website
 * lead form — where the aim is to stop a script filling the owner's phone
 * with `lead.created` buzzes, not to meter a paid API. It is per process:
 * two web containers each allow the full budget, and a restart forgets
 * everything, which is fine for a form that gets a handful of posts a day.
 * Nothing here needs Redis (CLAUDE.md: none), and pg-boss is not a counter.
 */
export type RateLimit = { limit: number; windowMs: number };

type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly rule: RateLimit) {}

  /** Counts one hit for `key`; false once the window's budget is spent. */
  allow(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.rule.windowMs });
      return true;
    }
    if (bucket.count >= this.rule.limit) return false;
    this.buckets.set(key, { ...bucket, count: bucket.count + 1 });
    return true;
  }

  /** Seconds until `key` may try again — for a `retry-after` header. Zero when it may try now. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now || bucket.count < this.rule.limit) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }

  /**
   * Expired buckets are dropped as a side effect of a hit, so a burst of
   * distinct addresses cannot grow the map without bound between requests.
   */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

/**
 * The caller's address as the proxy in front of this app reports it. Coolify
 * puts Traefik in front, which sets `x-forwarded-for`; the first entry is the
 * client. Without the header (a direct local call) every caller shares one
 * bucket, which is the safe direction for a limiter.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
