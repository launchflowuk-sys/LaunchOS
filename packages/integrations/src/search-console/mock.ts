import type { SearchAnalyticsQuery, SearchAnalyticsRow, SearchConsoleAdapter, UrlInspection } from "./types.js";

/**
 * Search Console without Google.
 *
 * Deterministic, because a dev screen that reshuffles on every refresh cannot
 * be looked at and a test that does cannot be trusted. Every number is derived
 * from the property and the grouping key, so the same query always gives the
 * same answer and two different properties never give the same one.
 *
 * `live` is false, so anything rendering these can say so. That matters more
 * here than in most mocks: search numbers look exactly as plausible when
 * invented as when real, and a client shown fabricated traffic is a problem
 * no amount of "it was only the mock" repairs.
 */
const MOCK_QUERIES = ["web design grays", "website designer essex", "launchflow", "small business website uk", "web developer thurrock"];

/** FNV-1a. Small, stable across runs, and not pretending to be a hash for anything that matters. */
function seed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function datesBetween(startDate: string, endDate: string): string[] {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  // Capped so a mistyped decade cannot build a million-row array in a dev screen.
  for (let at = start; at <= end && days.length < 400; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

function rowFor(siteUrl: string, key: string): SearchAnalyticsRow {
  const base = seed(`${siteUrl}|${key}`);
  const impressions = 40 + (base % 460);
  const clicks = Math.round(impressions * (0.02 + ((base >>> 8) % 60) / 1000));
  return {
    keys: [key],
    clicks,
    impressions,
    ctr: impressions === 0 ? 0 : clicks / impressions,
    position: Number((1 + ((base >>> 16) % 280) / 10).toFixed(1)),
  };
}

export class MockSearchConsoleAdapter implements SearchConsoleAdapter {
  readonly name = "mock";
  readonly live = false;

  async searchAnalytics(siteUrl: string, query: SearchAnalyticsQuery): Promise<readonly SearchAnalyticsRow[]> {
    const grouping = query.dimensions[0] ?? "date";
    const keys = grouping === "date" ? datesBetween(query.startDate, query.endDate) : MOCK_QUERIES;
    const rows = keys.map((key) => rowFor(siteUrl, key));
    // Terms come back best-first, the way Google sends them; dates stay in order.
    const ordered = grouping === "date" ? rows : [...rows].sort((a, b) => b.clicks - a.clicks);
    return ordered.slice(0, query.rowLimit ?? ordered.length);
  }

  async inspectUrl(_siteUrl: string, url: string): Promise<UrlInspection> {
    return {
      url,
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      lastCrawlTime: "2026-09-01T00:00:00Z",
    };
  }
}
