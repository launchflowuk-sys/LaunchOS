/**
 * The shared HTTP shell for the real DNS providers: one bearer-token client
 * with a single retry on 429, and one error type so callers upstream can tell
 * "the token is wrong" from "the zone is not ours" from "the API is busy".
 *
 * Neither provider is allowed to report `applied: true` on anything it did not
 * see confirmed, so every non-2xx here becomes a throw rather than a soft
 * result — a DNS change that quietly did nothing is the same class of bug as a
 * mock email adapter reporting a delivery.
 */

export type DnsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type DnsErrorKind =
  | "auth"
  | "zone_not_found"
  | "record_not_found"
  | "rate_limited"
  | "http"
  | "network"
  | "malformed";

export class DnsApiError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: DnsErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = "DnsApiError";
  }
}

export interface DnsHttpOptions {
  /** Bearer token. Never logged, never put in a URL. */
  token: string;
  /** Overridable so tests and staging can point somewhere else. */
  baseUrl?: string;
  /** Injectable for tests; defaults to the global `fetch` at call time. */
  fetch?: DnsFetch;
  timeoutMs?: number;
  /** Pause before the single 429 retry. Tests pass 0. */
  retryDelayMs?: number;
}

export interface DnsHttpResponse<T> {
  status: number;
  body: T | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** One retry, not a loop: a queued approval that fails is retried by a human. */
const RATE_LIMIT_RETRIES = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The human-readable half of an error body, for both API shapes:
 * Cloudflare's `{ errors: [{ code, message }] }` and Hostinger's
 * `{ message }` / `{ errors: { field: ["..."] } }`.
 */
export function errorMessageFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.length > 0) return record.message;
  const errors = record.errors;
  if (Array.isArray(errors)) {
    const messages = errors
      .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>).message : e))
      .filter((m): m is string => typeof m === "string");
    if (messages.length > 0) return messages.join("; ");
  }
  if (typeof errors === "object" && errors !== null) {
    const messages = Object.values(errors as Record<string, unknown>)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((m): m is string => typeof m === "string");
    if (messages.length > 0) return messages.join("; ");
  }
  return null;
}

export class DnsHttpClient {
  constructor(
    private readonly provider: string,
    private readonly options: DnsHttpOptions,
  ) {}

  private get fetchImpl(): DnsFetch {
    return this.options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Sends one request, retrying once on 429. Returns 2xx and 404 to the caller
   * (only the caller knows whether a 404 means "no such zone" or "no such
   * record"); everything else throws a classified `DnsApiError`.
   */
  async send<T>(method: string, url: string, body?: unknown): Promise<DnsHttpResponse<T>> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.once(method, url, body);
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      return this.classify<T>(response);
    }
  }

  private async once(method: string, url: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DnsApiError(
        this.provider,
        "network",
        `${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async classify<T>(response: Response): Promise<DnsHttpResponse<T>> {
    const body = await readJson(response);
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new DnsApiError(
        this.provider,
        "auth",
        `the API rejected the token (${status}): ${errorMessageFrom(body) ?? "authentication failed"}`,
        status,
      );
    }
    if (status === 429) {
      throw new DnsApiError(
        this.provider,
        "rate_limited",
        `rate limited (429) after ${RATE_LIMIT_RETRIES} retry: ${errorMessageFrom(body) ?? "too many requests"}`,
        status,
      );
    }
    if (status !== 404 && (status < 200 || status >= 300)) {
      throw new DnsApiError(
        this.provider,
        "http",
        `the API returned ${status}: ${errorMessageFrom(body) ?? "no error message"}`,
        status,
      );
    }
    return { status, body: body as T | null };
  }
}

/** A body that is not JSON is not an error on its own — a 204 has none. */
async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.trim().length === 0) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
