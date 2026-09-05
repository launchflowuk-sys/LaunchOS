import type { SocialChannel } from "./types.js";

/** Same reasoning as `ads/errors.ts`: the body ends up in `content_items.last_error` and a log line. */
const MAX_DETAIL_CHARS = 400;

function truncate(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * What the publish job does with each is different, which is why they are
 * separate: `auth` and `invalid_media` are for a human (re-issue the token,
 * pick another image) and retrying is pointless; `rate_limit` and `timeout`
 * will probably clear on the next run; `request_failed` is everything else.
 */
export type SocialErrorCode = "auth" | "rate_limit" | "invalid_media" | "timeout" | "request_failed";

export class SocialApiError extends Error {
  readonly channel: SocialChannel;
  readonly code: SocialErrorCode;
  /** HTTP status of the failing reply, or 0 when nothing came back. */
  readonly status: number;
  readonly detail: string;

  constructor(channel: SocialChannel, status: number, detail: string, summary?: string, code: SocialErrorCode = "request_failed") {
    super(`${channel} publish ${status}: ${summary ?? truncate(detail)}`);
    this.name = "SocialApiError";
    this.channel = channel;
    this.code = code;
    this.status = status;
    this.detail = truncate(detail);
  }
}

/** The token is expired, revoked, or lacks a permission. Never retried. */
export class SocialAuthError extends SocialApiError {
  constructor(channel: SocialChannel, status: number, detail: string, summary?: string) {
    super(channel, status, detail, summary, "auth");
    this.name = "SocialAuthError";
  }
}

/** Graph is throttling the app or the page. Retried once in-process, then left to the next run. */
export class SocialRateLimitError extends SocialApiError {
  constructor(channel: SocialChannel, status: number, detail: string, summary?: string) {
    super(channel, status, detail, summary, "rate_limit");
    this.name = "SocialRateLimitError";
  }
}

/** The image could not be fetched or is not something the channel accepts. Needs a different image, not a retry. */
export class SocialInvalidMediaError extends SocialApiError {
  constructor(channel: SocialChannel, status: number, detail: string, summary?: string) {
    super(channel, status, detail, summary, "invalid_media");
    this.name = "SocialInvalidMediaError";
  }
}
