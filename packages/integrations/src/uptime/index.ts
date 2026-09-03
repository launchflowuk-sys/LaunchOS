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

const BLOCKED_HOSTNAMES = new Set(["localhost", "host.docker.internal"]);

/** IPv4 literal in dotted-quad form, or `null` when the host is not one. */
function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isPrivateIpv4(hostname: string): boolean {
  const ip = parseIpv4(hostname);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 127) return true; // 127/8 loopback
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  // URL parsing keeps IPv6 literals in brackets; strip them and any zone id.
  const raw = hostname.replace(/^\[/, "").replace(/\]$/, "").split("%")[0]!.toLowerCase();
  if (!raw.includes(":")) return false;
  if (raw === "::1") return true; // loopback
  const first = raw.split(":")[0] ?? "";
  if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]?$/.test(first)) return true; // fe80::/10 link-local
  return false;
}

/**
 * True when the URL must not be fetched: a non-HTTP(S) scheme, or a host that
 * resolves to the machine or the private network around it (SSRF guard).
 */
export function isBlockedTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (isPrivateIpv4(hostname)) return true;
  if (isPrivateIpv6(hostname)) return true;
  return false;
}

export class HttpUptimeProbe implements UptimeProbe {
  constructor(private readonly timeoutMs = 10000) {}

  async check(url: string): Promise<UptimeResult> {
    if (isBlockedTarget(url)) return { ok: false, error: "blocked target" };
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { ok: res.status < 500, statusCode: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
