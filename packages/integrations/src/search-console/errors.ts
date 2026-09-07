/** Same reasoning as `ads/errors.ts` and `social/errors.ts`: the body ends up in a log line and, later, on a screen. */
const MAX_DETAIL_CHARS = 400;

function truncate(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * What the caller does with each differs, which is why they are separate.
 *
 * `auth` needs a person: the service account was never added to the property,
 * or was removed from it. Retrying that forever is how a job spins for a week
 * without anyone learning the one fact that would fix it.
 *
 * `quota` is the URL Inspection ceiling — 2,000 a day per property. It clears
 * at midnight Pacific whatever we do, so the run stops rather than retries.
 */
export type SearchConsoleErrorCode = "auth" | "quota" | "request_failed";

export class SearchConsoleError extends Error {
  readonly code: SearchConsoleErrorCode;
  /** HTTP status of the failing reply, or 0 when nothing came back. */
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string, summary?: string, code: SearchConsoleErrorCode = "request_failed") {
    super(`search console ${status}: ${summary ?? truncate(detail)}`);
    this.name = "SearchConsoleError";
    this.code = code;
    this.status = status;
    this.detail = truncate(detail);
  }
}

/**
 * The service account cannot see this property.
 *
 * Almost always one cause: nobody added it under Settings → Users and
 * permissions. Google answers 403 for that, which is indistinguishable from a
 * scope problem at the HTTP layer, so the message says both.
 */
export class SearchConsoleAuthError extends SearchConsoleError {
  constructor(status: number, detail: string, summary?: string) {
    super(status, detail, summary ?? "service account cannot read this property — check it is added under Settings → Users and permissions", "auth");
    this.name = "SearchConsoleAuthError";
  }
}

/** The daily inspection quota is spent. Nothing to do until it resets. */
export class SearchConsoleQuotaError extends SearchConsoleError {
  constructor(status: number, detail: string, summary?: string) {
    super(status, detail, summary ?? "daily quota exhausted", "quota");
    this.name = "SearchConsoleQuotaError";
  }
}
