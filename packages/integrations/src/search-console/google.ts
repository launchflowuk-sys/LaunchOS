import { createHttpRuntime, isRecord, parseJson, sendWithRetry, type AdsHttpOptions, type HttpRuntime } from "../ads/http.js";
import { ServiceAccountTokenSource, type ServiceAccountCredentials } from "./auth.js";
import { SearchConsoleAuthError, SearchConsoleError, SearchConsoleQuotaError } from "./errors.js";
import type { SearchAnalyticsQuery, SearchAnalyticsRow, SearchConsoleAdapter, UrlInspection } from "./types.js";

/**
 * Search Console over plain REST.
 *
 * Two endpoints on two different API versions, which is Google's doing rather
 * than a mistake here: search analytics still lives under the old `webmasters/v3`
 * path, URL inspection arrived later under `v1`. Both are on the same host and
 * take the same bearer token.
 */
const ANALYTICS_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
/** Google's own ceiling is 25,000. A screen shows tens; a job that wants more should page deliberately. */
const DEFAULT_ROW_LIMIT = 500;
const MAX_ROW_LIMIT = 25_000;

export interface GoogleSearchConsoleOptions extends AdsHttpOptions {
  /** Overridden in tests. */
  readonly analyticsBase?: string;
  readonly inspectionUrl?: string;
  readonly tokenUrl?: string;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Turn a failing reply into the error whose *handling* is right.
 *
 * 403 is the one worth naming: it is what Google says when the service account
 * was never added to the property, which is the single most likely thing to be
 * wrong on a first run and the one thing a stack trace never says.
 */
function failed(status: number, text: string): SearchConsoleError {
  const parsed = parseJson(text);
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
  const message = typeof error.message === "string" ? error.message : undefined;

  if (status === 401 || status === 403) return new SearchConsoleAuthError(status, text, message);
  // 429 here is the 2,000-a-day inspection ceiling far more often than a burst.
  if (status === 429) return new SearchConsoleQuotaError(status, text, message);
  return new SearchConsoleError(status, text, message);
}

export class GoogleSearchConsoleAdapter implements SearchConsoleAdapter {
  readonly name = "google-search-console";
  readonly live = true;

  private readonly http: HttpRuntime;
  private readonly tokens: ServiceAccountTokenSource;
  private readonly analyticsBase: string;
  private readonly inspectionUrl: string;

  constructor(credentials: ServiceAccountCredentials, options: GoogleSearchConsoleOptions = {}) {
    this.http = createHttpRuntime(options);
    this.tokens = new ServiceAccountTokenSource(credentials, this.http, undefined, options.tokenUrl);
    this.analyticsBase = options.analyticsBase ?? ANALYTICS_BASE;
    this.inspectionUrl = options.inspectionUrl ?? INSPECTION_URL;
  }

  async searchAnalytics(siteUrl: string, query: SearchAnalyticsQuery): Promise<readonly SearchAnalyticsRow[]> {
    // The property is a URL inside a URL — `https://launchflow.co.uk/` becomes
    // `https%3A%2F%2Flaunchflow.co.uk%2F`. Missing this is a 404 that reads
    // like the property does not exist.
    const url = `${this.analyticsBase}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const rowLimit = Math.min(query.rowLimit ?? DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
    const payload = await this.post(url, {
      startDate: query.startDate,
      endDate: query.endDate,
      dimensions: [...query.dimensions],
      rowLimit,
    });

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    // An empty `rows` is normal, not an error: a property with no impressions
    // in the window, or one Google has not finished processing, answers 200
    // with nothing in it.
    return rows.filter(isRecord).map((row) => ({
      keys: Array.isArray(row.keys) ? row.keys.map((key) => String(key)) : [],
      clicks: toNumber(row.clicks),
      impressions: toNumber(row.impressions),
      ctr: toNumber(row.ctr),
      position: toNumber(row.position),
    }));
  }

  async inspectUrl(siteUrl: string, url: string): Promise<UrlInspection> {
    const payload = await this.post(this.inspectionUrl, { inspectionUrl: url, siteUrl });
    const result = isRecord(payload.inspectionResult) ? payload.inspectionResult : {};
    const status = isRecord(result.indexStatusResult) ? result.indexStatusResult : {};

    return {
      url,
      verdict: typeof status.verdict === "string" ? status.verdict : "VERDICT_UNSPECIFIED",
      coverageState: typeof status.coverageState === "string" ? status.coverageState : "",
      robotsTxtState: typeof status.robotsTxtState === "string" ? status.robotsTxtState : "",
      lastCrawlTime: typeof status.lastCrawlTime === "string" ? status.lastCrawlTime : null,
    };
  }

  private async post(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const send = async (): Promise<{ status: number; ok: boolean; text: string }> => {
      const token = await this.tokens.accessToken();
      return sendWithRetry(this.http, {
        url,
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      }, (r) => r.status === 429 || r.status >= 500);
    };

    let reply = await send();
    // One retry on 401 with a fresh token. A cached token that Google revoked
    // early would otherwise fail every call for the life of the process.
    if (reply.status === 401) {
      this.tokens.forget();
      reply = await send();
    }
    if (!reply.ok) throw failed(reply.status, reply.text);

    const parsed = parseJson(reply.text);
    return isRecord(parsed) ? parsed : {};
  }
}
