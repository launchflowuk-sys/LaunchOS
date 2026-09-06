import { ImageGenRefused, type ImageGenAdapterName, type ImageGenRefusalCode } from "./types.js";

/**
 * A minute. Long, on purpose: `gpt-image-1` regularly takes twenty to forty
 * seconds on a square, and a render that is abandoned at ten has still been
 * paid for. The caller is a queued worker job, not a request holding a page
 * open, so waiting is cheap and giving up early is not.
 */
export const IMAGEGEN_TIMEOUT_MS = 60_000;

/** What a caller may inject beyond the credentials — `fetch` and the clock in tests, nothing in production. */
export interface ImageGenHttpOptions {
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Injected in tests so nothing ever reaches a real provider. */
  endpoint?: string | undefined;
}

/**
 * One outbound call, with the timeout every provider call in this package
 * carries. Anything that is not a `Response` — an abort, a DNS failure, a
 * socket reset — comes back as an `ImageGenRefused` so the caller has one
 * error type to catch rather than two.
 */
export async function imageGenFetch(
  provider: ImageGenAdapterName,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ImageGenRefused(provider, 0, `no answer within ${timeoutMs} ms`, "timeout");
    }
    throw new ImageGenRefused(provider, 0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A refusal a human can act on without opening the provider's dashboard: the
 * key is wrong, we are being throttled, or the prompt was rejected. Everything
 * else is `request_failed` and will be retried by whoever queued the render.
 *
 * The content-policy test reads the *body*, not the status, because neither
 * provider gives moderation its own code — OpenAI returns a 400 whose error
 * names `moderation_blocked`, fal a 422 whose detail mentions its safety
 * checker — and the difference matters: a rejected prompt is reworded, never
 * retried.
 */
export function refusalCodeFor(status: number, detail: string): ImageGenRefusalCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (/moderation|content[_ ]polic|safety|nsfw/i.test(detail)) return "content_policy";
  return "request_failed";
}

/**
 * The most useful sentence a failing reply carries, whatever shape it is in.
 * OpenAI answers `{ error: { message } }`, fal `{ detail: [{ msg }] }` or
 * `{ detail: "…" }`, and a proxy in front of either answers HTML — so the raw
 * text is the fallback rather than an empty string. `ImageGenRefused` truncates
 * whatever comes out of here.
 */
export async function readRefusalDetail(res: Response): Promise<string> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    return "";
  }
  try {
    const body: unknown = JSON.parse(raw);
    const message = pickMessage(body);
    if (message) return message;
  } catch {
    // Not JSON. The raw text is still the best thing we have.
  }
  return raw;
}

function pickMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record["message"] === "string") return record["message"];
  if (typeof record["detail"] === "string") return record["detail"];
  const error = record["error"];
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  const detail = record["detail"];
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["msg"] : null))
      .filter((msg): msg is string => typeof msg === "string");
    if (messages.length > 0) return messages.join("; ");
  }
  return null;
}

/** Reads and classifies a non-2xx in one go, for the `if (!res.ok) throw await …` line every adapter has. */
export async function refusalFrom(provider: ImageGenAdapterName, res: Response): Promise<ImageGenRefused> {
  const detail = await readRefusalDetail(res);
  return new ImageGenRefused(provider, res.status, detail, refusalCodeFor(res.status, detail));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * What these bytes actually are, ignoring what the provider claimed. A
 * `content-type` from a CDN is a hint; the first four bytes are the fact, and
 * `createContentAsset` will reject a mime that does not match the file it is
 * handed. Null when it is neither of the two we store.
 */
export function sniffImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  return null;
}
