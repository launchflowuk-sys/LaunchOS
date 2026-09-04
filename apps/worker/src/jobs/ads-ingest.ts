import { ingestDailyMetrics, type IngestResult } from "@launchos/core";
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
