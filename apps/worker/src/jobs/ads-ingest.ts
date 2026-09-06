import {
  ingestDailyCampaignMetrics, ingestDailyMetrics,
  type CampaignIngestResult, type IngestResult,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import type { AdsAdapter } from "@launchos/integrations";

/** Ingests yesterday's metrics — today's are still accumulating at 06:30. */
export async function runAdsIngest(
  db: Db,
  organisationId: string,
  ads: AdsAdapter,
  options: { now: Date },
): Promise<IngestResult> {
  const date = new Date(options.now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return ingestDailyMetrics(db, organisationId, { date }, ads);
}

/**
 * The same day cut by campaign, run straight after the account totals.
 *
 * Deliberately a second call rather than one that does both: the account-level
 * snapshot is what a client's report and the Sentinel's signals are built on,
 * and a provider that has stopped answering the campaign query must not take
 * those down with it. Cost per lead per campaign degrades to "spend we could
 * not place"; the client report does not degrade at all.
 */
export async function runAdsCampaignIngest(
  db: Db,
  organisationId: string,
  ads: AdsAdapter,
  options: { now: Date },
): Promise<CampaignIngestResult> {
  const date = new Date(options.now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return ingestDailyCampaignMetrics(db, organisationId, { date }, ads);
}
