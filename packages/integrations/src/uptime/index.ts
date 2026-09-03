export interface UptimeResult {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

export interface UptimeProbe {
  check(url: string): Promise<UptimeResult>;
}

export class MockUptimeProbe implements UptimeProbe {
  constructor(public readonly downUrls = new Set<string>()) {}

  async check(url: string): Promise<UptimeResult> {
    return this.downUrls.has(url)
      ? { ok: false, statusCode: 503, latencyMs: 30000, error: "503 Service Unavailable" }
      : { ok: true, statusCode: 200, latencyMs: 120 };
  }
}

export class HttpUptimeProbe implements UptimeProbe {
  constructor(private readonly timeoutMs = 10000) {}

  async check(url: string): Promise<UptimeResult> {
    const started = Date.now();
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
      return { ok: res.status < 500, statusCode: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
