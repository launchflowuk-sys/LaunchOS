import type { AdPlatform } from "./types.js";

/** Provider bodies can be long (Google returns the whole request context on a
 * failure). `ingestDailyMetrics` puts `error.message` straight into
 * `IngestFailure.error` and a `console.error` line, so an untruncated body
 * would bury the run log under one bad account. */
const MAX_DETAIL_CHARS = 400;

function truncate(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * A call to an ads provider that came back as a failure.
 *
 * The three shapes are separated because the caller does different things with
 * them: `AdsAuthError` means a human has to go and re-issue a credential and no
 * retry will ever help, `AdsRateLimitError` means the same call will probably
 * work later (the cron re-run is enough), and a plain `AdsApiError` is
 * everything else — a bad account id, a schema change, a provider outage.
 */
export class AdsApiError extends Error {
  readonly platform: AdPlatform;
  readonly status: number;
  readonly detail: string;

  constructor(platform: AdPlatform, status: number, detail: string, summary?: string) {
    super(`${platform} ads api ${status}: ${summary ?? truncate(detail)}`);
    this.name = "AdsApiError";
    this.platform = platform;
    this.status = status;
    this.detail = truncate(detail);
  }
}

/** The credential is wrong, expired, revoked or lacks permission. Never retried. */
export class AdsAuthError extends AdsApiError {
  constructor(platform: AdPlatform, status: number, detail: string, summary?: string) {
    super(platform, status, detail, summary);
    this.name = "AdsAuthError";
  }
}

/** The provider is throttling us. Retried once in-process, then left to the cron. */
export class AdsRateLimitError extends AdsApiError {
  constructor(platform: AdPlatform, status: number, detail: string, summary?: string) {
    super(platform, status, detail, summary);
    this.name = "AdsRateLimitError";
  }
}

/**
 * A multi-platform adapter was asked for an account it cannot attribute to a
 * platform. Distinct from `AdsApiError` because nothing was ever sent.
 */
export class AdsRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsRoutingError";
  }
}
