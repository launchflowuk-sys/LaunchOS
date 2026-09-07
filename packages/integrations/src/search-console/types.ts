/**
 * What Search Console will tell us, and what it will not.
 *
 * The API publishes four things. Only two are worth an adapter: **search
 * analytics** (what people searched, what we were shown for, what they
 * clicked) and **URL inspection** (whether one address is indexed). Sitemaps
 * and site listing are a click in a browser once a year.
 *
 * **The index coverage report is not in the API.** There is no endpoint that
 * returns "here are your 404s" — that list only exists as a CSV export from
 * the browser. Anything in LaunchOS that wants coverage has to inspect URLs
 * one at a time, within a 2,000-a-day quota, against a list it already holds.
 * Worth writing down because it is the first thing anyone assumes is there.
 */

/** A row of search performance, already summed over whatever was grouped. */
export interface SearchAnalyticsRow {
  /** The grouped values, in the order they were requested: `["plumber grays"]`. */
  readonly keys: readonly string[];
  readonly clicks: number;
  readonly impressions: number;
  /** Clicks over impressions, 0–1. Google sends it; we do not recompute it. */
  readonly ctr: number;
  /** Mean position, 1-based. Lower is better. */
  readonly position: number;
}

/** How to group a search analytics query. `date` for a trend, `query` for terms. */
export type SearchAnalyticsDimension = "date" | "query" | "page" | "country" | "device";

export interface SearchAnalyticsQuery {
  /** Inclusive, `YYYY-MM-DD`, in the property's own timezone. */
  readonly startDate: string;
  readonly endDate: string;
  readonly dimensions: readonly SearchAnalyticsDimension[];
  /** Google caps this at 25,000; we default far lower. */
  readonly rowLimit?: number;
}

/**
 * Whether Google has this page, and why not when it does not.
 *
 * `verdict` is Google's own word for it, passed through rather than mapped:
 * mapping it would mean inventing a vocabulary that drifts from the one in
 * the Search Console UI the reader is looking at.
 */
export interface UrlInspection {
  readonly url: string;
  /** `PASS`, `NEUTRAL`, `FAIL`, or `VERDICT_UNSPECIFIED`. */
  readonly verdict: string;
  /** e.g. `URL is unknown to Google`, `Submitted and indexed`. */
  readonly coverageState: string;
  /** Whether a crawl is allowed, as Google sees it. */
  readonly robotsTxtState: string;
  /** Last crawl, ISO 8601, or null when never crawled. */
  readonly lastCrawlTime: string | null;
}

export interface SearchConsoleAdapter {
  readonly name: string;
  /** False for the mock, so a screen can say the numbers are not real. */
  readonly live: boolean;
  /** Search performance for one property. `siteUrl` is the property exactly as Search Console spells it. */
  searchAnalytics(siteUrl: string, query: SearchAnalyticsQuery): Promise<readonly SearchAnalyticsRow[]>;
  /** One URL's index status. Quota is 2,000 a day per property — callers must batch deliberately. */
  inspectUrl(siteUrl: string, url: string): Promise<UrlInspection>;
}
