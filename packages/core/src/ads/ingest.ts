import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { AdsAdapter } from "@launchos/integrations";
import { z } from "zod";
import { listAdAccounts } from "./accounts.js";

export const IngestDailyMetricsInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO calendar date"),
});
export type IngestDailyMetricsInput = z.input<typeof IngestDailyMetricsInput>;

export interface IngestResult {
  date: string;
  accounts: number;
  snapshots: number;
}

/**
 * Pulls one day of metrics for every active ad account.
 *
 * The adapter is injected rather than built from env so `core` never picks an
 * integration (CLAUDE.md rule 4) and tests can pass the deterministic mock.
 * Upserting on (ad_account_id, date) makes a re-run of the cron harmless — a
 * provider that restates yesterday's figures simply overwrites them.
 */
export async function ingestDailyMetrics(
  db: Db,
  organisationId: string,
  input: IngestDailyMetricsInput,
  ads: AdsAdapter,
): Promise<IngestResult> {
  const v = IngestDailyMetricsInput.parse(input);
  const accounts = await listAdAccounts(db, organisationId, { status: "active" });

  let snapshots = 0;
  for (const account of accounts) {
    const metrics = await ads.fetchDailyMetrics(account.externalId, v.date);
    await db.insert(schema.adMetricSnapshots).values({
      organisationId,
      adAccountId: account.id,
      date: v.date,
      spendPence: metrics.spendPence,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      conversions: metrics.conversions,
      conversionValuePence: metrics.conversionValuePence,
      cpcPence: metrics.cpcPence,
      roas: metrics.roas,
    }).onConflictDoUpdate({
      target: [schema.adMetricSnapshots.adAccountId, schema.adMetricSnapshots.date],
      set: {
        spendPence: metrics.spendPence,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        conversions: metrics.conversions,
        conversionValuePence: metrics.conversionValuePence,
        cpcPence: metrics.cpcPence,
        roas: metrics.roas,
        updatedAt: new Date(),
      },
    });
    snapshots += 1;
  }
  // Telemetry, not a business action: snapshots are exempt from audit_log
  // (CLAUDE.md rule 3). The ticket the Sentinel raises from them is audited.
  return { date: v.date, accounts: accounts.length, snapshots };
}
