import { captureSiteScreenshot, sitesMissingScreenshot } from "@launchos/core";
import type { Db } from "@launchos/db";
import type { ScreenshotAdapter } from "@launchos/integrations";

/**
 * How many sites one run photographs.
 *
 * A ceiling rather than "all of them", because each capture is a paid call to
 * a third party and a runaway loop over a table is how a provider bill becomes
 * a surprise. `sitesMissingScreenshot` returns only sites that have never been
 * captured, so a run that hits the ceiling still makes progress and the next
 * one picks up where it stopped.
 */
export const SCREENSHOT_BATCH = 25;

export interface ScreenshotRunResult {
  readonly attempted: number;
  readonly captured: number;
  readonly failed: number;
}

/**
 * Gives newly added sites their first thumbnail.
 *
 * Not a refresh: a thumbnail identifies a site, and that does not change, so
 * re-shooting all of them on a schedule was paying a provider daily to keep a
 * correct picture correct. Whether a site is broken is answered by monitors and
 * incidents, which alert; a picture is not a monitor. A deliberate refresh is
 * the button on the site card.
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
  const due = await sitesMissingScreenshot(db, organisationId, options.limit ?? SCREENSHOT_BATCH);

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
