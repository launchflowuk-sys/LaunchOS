/**
 * The one HTTP path both real ad adapters use.
 *
 * Deliberately plain `fetch` and no provider SDK: the Google Ads client library
 * pulls in gRPC and protobuf codegen, and `facebook-nodejs-business-sdk` ships
 * a generated class per API object. Two REST calls each do not justify either,
 * and both are pinned to an API version we choose rather than one a package
 * bump chooses for us.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdsHttpOptions {
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injected in tests so a retry does not really wait a second. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Retries *after* the first attempt. One by default. */
  retries?: number;
}

export interface HttpRuntime {
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeoutMs: number;
  readonly retries: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export function createHttpRuntime(options: AdsHttpOptions = {}): HttpRuntime {
  return {
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? 1,
  };
}

export interface HttpRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export interface HttpReply {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly text: string;
}

/** `Retry-After` in seconds, clamped. An HTTP-date form is ignored — providers
 * send seconds, and a bad header must not park the worker for hours. */
function retryDelayMs(headers: Headers): number {
  const raw = headers.get("retry-after");
  const seconds = raw === null ? Number.NaN : Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

async function send(runtime: HttpRuntime, request: HttpRequest): Promise<HttpReply> {
  const init: RequestInit = request.init.signal
    ? request.init
    : { ...request.init, signal: AbortSignal.timeout(runtime.timeoutMs) };
  const response = await runtime.fetch(request.url, init);
  const headers = response.headers ?? new Headers();
  const text = await response.text();
  return { status: response.status, ok: response.status >= 200 && response.status < 300, headers, text };
}

/**
 * Sends `request`, retrying only what `isRetryable` accepts.
 *
 * The predicate is per-provider because the two disagree about what a throttle
 * looks like on the wire: Google sends 429, Meta routinely sends HTTP 400 with
 * an error code in the body. Retrying a 4xx blindly would turn one bad account
 * id into two failed calls a day, forever.
 */
export async function sendWithRetry(
  runtime: HttpRuntime,
  request: HttpRequest,
  isRetryable: (reply: HttpReply) => boolean,
): Promise<HttpReply> {
  let attempt = 0;
  for (;;) {
    const reply = await send(runtime, request);
    if (reply.ok || attempt >= runtime.retries || !isRetryable(reply)) return reply;
    await runtime.sleep(retryDelayMs(reply.headers));
    attempt += 1;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined` rather than a throw, so the caller can attach the raw body. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The single validation that stops a caller's string reaching a GAQL `WHERE`
 * clause or a Graph `time_range` unescaped.
 */
export function assertIsoDate(date: string): string {
  if (!ISO_DATE.test(date)) throw new TypeError(`ads: date must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}`);
  return date;
}
