import { refreshSiteReviews, sitesDueReviewRefresh } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { ReviewsProvider } from "@launchos/integrations";

/**
 * How many listings one run reads.
 *
 * A Places Details call with the Atmosphere fields is Google's dearest field
 * group, so this is a spend ceiling rather than a performance one. Well above
 * the real number of sites with reviews switched on, and `sitesDueReviewRefresh`
 * returns only sites that are actually stale — so a run that hit the ceiling
 * would still make progress and the next one would pick up the rest.
 */
export const REVIEWS_BATCH = 50;

export interface ReviewsRunResult {
  readonly attempted: number;
  readonly refreshed: number;
  readonly failed: number;
  /** Named so a failing listing appears in the worker log rather than only in a column. */
  readonly failures: readonly { site: string; reason: string }[];
}

/**
 * Keeps every enabled site's reviews within a day of Google's.
 *
 * Sequential, not parallel. Fifty sequential HTTP calls take under a minute
 * and the alternative is fifty simultaneous requests on one API key, which is
 * how a shared quota turns into `OVER_QUERY_LIMIT` for every client at once.
 * Nothing is waiting on this run.
 *
 * One listing failing is normal and is not a run failure: a client can unclaim
 * a Business Profile without telling anybody. The reason is stored on the row
 * by `refreshSiteReviews` and the last good reviews are left in place, so the
 * client's homepage keeps working while somebody looks at it.
 */
export async function runSiteReviews(
  db: Db,
  organisationId: string,
  provider: ReviewsProvider,
  options: { now?: Date } = {},
): Promise<ReviewsRunResult> {
  const now = options.now ?? new Date();
  const due = (await sitesDueReviewRefresh(db, organisationId, { now })).slice(0, REVIEWS_BATCH);

  let refreshed = 0;
  const failures: { site: string; reason: string }[] = [];

  for (const site of due) {
    try {
      const result = await refreshSiteReviews(db, organisationId, provider, { siteId: site.siteId, now });
      if (result.refreshed) refreshed += 1;
      else failures.push({ site: site.name, reason: result.reason ?? "unknown" });
    } catch (error) {
      // `refreshSiteReviews` records and returns provider refusals, so
      // reaching here means something structural — a site deleted mid-run, a
      // place id cleared between the query and the call. Log it and carry on
      // with the rest rather than abandoning the sweep.
      failures.push({ site: site.name, reason: error instanceof Error ? error.message : "unknown error" });
    }
  }

  return { attempted: due.length, refreshed, failed: failures.length, failures };
}
