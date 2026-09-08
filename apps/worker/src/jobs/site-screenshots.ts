import { captureSiteScreenshot, sitesDueForScreenshot } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { ScreenshotAdapter } from "@launchos/integrations";

/**
 * How many sites one nightly run photographs.
 *
 * A ceiling rather than "all of them", because each capture is a paid call to
 * a third party and a runaway loop over a table is how a provider bill becomes
 * a surprise. `sitesDueForScreenshot` returns the stalest first, so a run that
 * hits the ceiling still makes progress and tomorrow's picks up where this one
 * stopped — the set converges even if it never fits in one night.
 */
export const SCREENSHOT_BATCH = 25;

export interface ScreenshotRunResult {
  readonly attempted: number;
  readonly captured: number;
  readonly failed: number;
}

/**
 * Refreshes the thumbnails on the websites list.
 *
 * Sequential, not `Promise.all`: twenty-five simultaneous page renders is a
 * burst a provider rate-limits and a wall of failures we would then have to
 * explain. There is no deadline on a nightly job, so the slow, polite version
 * is the right one.
 *
 * Nothing here throws for a site that could not be photographed —
 * `captureSiteScreenshot` records the reason on the row and the list shows it.
 * A screenshot failing is not a reason for the job to fail.
 */
export async function runSiteScreenshots(
  db: Db,
  organisationId: string,
  screenshots: ScreenshotAdapter,
  options: { now: Date; limit?: number },
): Promise<ScreenshotRunResult> {
  const due = await sitesDueForScreenshot(db, organisationId, options.limit ?? SCREENSHOT_BATCH);

  let captured = 0;
  let failed = 0;
  for (const site of due) {
    const result = await captureSiteScreenshot(
      db,
      organisationId,
      { siteId: site.id, url: site.primaryUrl },
      screenshots,
      options.now,
    );
    if (result.ok) captured += 1;
    else failed += 1;
  }

  return { attempted: due.length, captured, failed };
}
