import { isRecord, parseJson, type HttpReply } from "../ads/http.js";
import { toNumber } from "../ads/money.js";
import { SocialApiError, SocialAuthError, SocialInvalidMediaError, SocialRateLimitError } from "./errors.js";
import type { SocialChannel } from "./types.js";

/**
 * Graph's error envelope, read the way `ads/meta.ts` reads it. The code sets
 * are repeated here rather than exported from the ads adapter because that
 * file is another phase's; the two lists should be kept in step by hand.
 *
 * Meta's own codes arrive with HTTP 400 as often as with 401 or 429, so the
 * body decides before the status does.
 */
const AUTH_CODES = new Set([10, 102, 190, 200, 210, 458, 459, 463, 464, 467, 2500]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);
/** 324: Facebook could not fetch or read the photo. 9004 / 36000-36003: Instagram media not found, too large, wrong format. */
const INVALID_MEDIA_CODES = new Set([324, 9004, 36000, 36001, 36003]);
/** The 2207xxx subcodes are all "your media is unusable" for the Instagram container. */
const INVALID_MEDIA_SUBCODE_MIN = 2207000;
const INVALID_MEDIA_SUBCODE_MAX = 2207999;

export interface GraphError {
  readonly message: string;
  readonly code: number;
  readonly subcode: number;
}

export function graphError(text: string): GraphError | undefined {
  const parsed = parseJson(text);
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
  const error = parsed.error;
  return {
    message: typeof error.message === "string" ? error.message : text,
    code: toNumber(error.code),
    subcode: toNumber(error.error_subcode),
  };
}

function isInvalidMedia(error: GraphError): boolean {
  if (INVALID_MEDIA_CODES.has(error.code)) return true;
  return error.subcode >= INVALID_MEDIA_SUBCODE_MIN && error.subcode <= INVALID_MEDIA_SUBCODE_MAX;
}

export function graphFailure(channel: SocialChannel, reply: HttpReply): SocialApiError {
  const error = graphError(reply.text);
  const summary = error?.message;
  if (error !== undefined) {
    if (AUTH_CODES.has(error.code)) return new SocialAuthError(channel, reply.status, reply.text, summary);
    if (RATE_LIMIT_CODES.has(error.code)) return new SocialRateLimitError(channel, reply.status, reply.text, summary);
    if (isInvalidMedia(error)) return new SocialInvalidMediaError(channel, reply.status, reply.text, summary);
  }
  if (reply.status === 401 || reply.status === 403) return new SocialAuthError(channel, reply.status, reply.text, summary);
  if (reply.status === 429) return new SocialRateLimitError(channel, reply.status, reply.text, summary);
  return new SocialApiError(channel, reply.status, reply.text, summary);
}

/**
 * A throttle is retried whether the call was a read or a write: Graph rejected
 * it, so nothing was posted. A 5xx is retried only for reads — a `POST /feed`
 * that timed out on Meta's side may well have published, and sending it again
 * would put the same post on the page twice.
 */
export function isGraphRetryable(method: "GET" | "POST"): (reply: HttpReply) => boolean {
  return (reply) => {
    if (reply.status === 429) return true;
    if (reply.status >= 500) return method === "GET";
    const error = graphError(reply.text);
    return error !== undefined && RATE_LIMIT_CODES.has(error.code);
  };
}
