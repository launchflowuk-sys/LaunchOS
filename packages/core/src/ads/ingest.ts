import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { AdsAdapter } from "@launchos/integrations";
import { z } from "zod";
import { listAdAccounts } from "./accounts.js";

export const IngestDailyMetricsInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO calendar date"),
});
export type IngestDailyMetricsInput = z.input<typeof IngestDailyMetricsInput>;

export interface IngestFailure {
  adAccountId: string;
  error: string;
}

export interface IngestResult {
  date: string;
  accounts: number;
  snapshots: number;
  failed: IngestFailure[];
}

/** Thrown when at least one account's fetch/write failed. Carries the full
 * result so a caller (or a test) can see which accounts still succeeded
 * rather than only learning that "something" failed. */
export class AdIngestError extends Error {
  readonly result: IngestResult;
  constructor(result: IngestResult) {
    super(`ad ingest failed for ${result.failed.length} of ${result.accounts} account(s) on ${result.date}`);
    this.name = "AdIngestError";
    this.result = result;
  }
}

/**
 * Pulls one day of metrics for every active ad account.
 *
 * The adapter is injected rather than built from env so `core` never picks an
 * integration (CLAUDE.md rule 4) and tests can pass the deterministic mock.
 * Upserting on (ad_account_id, date) makes a re-run of the cron harmless — a
 * provider that restates yesterday's figures simply overwrites them.
 *
 * One account's failure (a provider outage, a bad external id) must not sink
 * every other account's snapshot for the day, so each account is isolated in
 * its own try/catch: a failure is logged and recorded in `failed` rather than
 * thrown immediately, and every account that succeeds keeps its snapshot.
 * Once every account has been attempted, an `AdIngestError` is thrown if any
 * failed, so the pg-boss cron job sees the run as failed and retries it —
 * the retry is cheap because the upsert makes already-succeeded accounts a
 * no-op.
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
  const failed: IngestFailure[] = [];
  for (const account of accounts) {
    try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Structured logging, matching apps/worker's job-failure convention (e.g.
      // apps/worker/src/jobs/task-generation.ts) — no logger is wired into `core`.
      console.error({ organisationId, adAccountId: account.id, date: v.date, error: message }, "ad metric ingest failed for account");
      failed.push({ adAccountId: account.id, error: message });
    }
  }
  // Telemetry, not a business action: snapshots are exempt from audit_log
  // (CLAUDE.md rule 3). The ticket the Sentinel raises from them is audited.
  const result: IngestResult = { date: v.date, accounts: accounts.length, snapshots, failed };
  if (failed.length > 0) throw new AdIngestError(result);
  return result;
}
