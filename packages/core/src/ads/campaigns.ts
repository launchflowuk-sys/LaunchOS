import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { AdsAdapter } from "@launchos/integrations";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { listAdAccounts } from "./accounts.js";

/**
 * The campaign cut of a day's ad spend.
 *
 * Same shape as `ingestDailyMetrics` and run beside it: adapter injected, one
 * account's failure isolated, upsert on (account, date, campaign) so a re-run
 * is harmless. What it adds is the one dimension the account-level snapshot
 * cannot carry — which campaign the money went to — because that is the only
 * thing a lead's `utm_campaign` can be joined to.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO calendar date");

export const IngestCampaignMetricsInput = z.object({ date: IsoDate });
export type IngestCampaignMetricsInput = z.input<typeof IngestCampaignMetricsInput>;

export interface CampaignIngestFailure {
  adAccountId: string;
  error: string;
}

export interface CampaignIngestResult {
  date: string;
  accounts: number;
  /** Accounts whose adapter cannot break a day down. Not a failure — see the doc comment. */
  unsupported: number;
  campaigns: number;
  failed: CampaignIngestFailure[];
}

export class AdCampaignIngestError extends Error {
  readonly result: CampaignIngestResult;
  constructor(result: CampaignIngestResult) {
    super(`ad campaign ingest failed for ${result.failed.length} of ${result.accounts} account(s) on ${result.date}`);
    this.name = "AdCampaignIngestError";
    this.result = result;
  }
}

/**
 * Pulls one day of per-campaign figures for every active ad account.
 *
 * An adapter with no `fetchCampaignMetrics` is counted as `unsupported` and
 * skipped rather than failed: the account still has its daily total, and the
 * cost-per-lead screen reports that account's spend as unplaced. A provider
 * that *has* the query and errors is a real failure and is retried, exactly as
 * the account-level ingest treats one.
 *
 * Telemetry, so no `audit_log` row (CLAUDE.md rule 3) — the same exemption the
 * daily snapshots have.
 */
export async function ingestDailyCampaignMetrics(
  db: Db,
  organisationId: string,
  input: IngestCampaignMetricsInput,
  ads: AdsAdapter,
): Promise<CampaignIngestResult> {
  const v = IngestCampaignMetricsInput.parse(input);
  const accounts = await listAdAccounts(db, organisationId, { status: "active" });

  let campaigns = 0;
  let unsupported = 0;
  const failed: CampaignIngestFailure[] = [];
  for (const account of accounts) {
    if (!ads.fetchCampaignMetrics) {
      unsupported += 1;
      continue;
    }
    try {
      const rows = await ads.fetchCampaignMetrics(account.externalId, v.date, account.platform);
      for (const row of rows) {
        await db.insert(schema.adCampaignSnapshots).values({
          organisationId,
          adAccountId: account.id,
          date: v.date,
          campaignExternalId: row.campaignExternalId,
          campaignName: row.campaignName,
          spendPence: row.spendPence,
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          conversionValuePence: row.conversionValuePence,
        }).onConflictDoUpdate({
          target: [
            schema.adCampaignSnapshots.adAccountId,
            schema.adCampaignSnapshots.date,
            schema.adCampaignSnapshots.campaignExternalId,
          ],
          set: {
            // The name is refreshed on purpose: a campaign renamed today is
            // matched by its new name from today on, and the rows already
            // written for earlier days keep the name they were fetched under.
            campaignName: row.campaignName,
            spendPence: row.spendPence,
            impressions: row.impressions,
            clicks: row.clicks,
            conversions: row.conversions,
            conversionValuePence: row.conversionValuePence,
            updatedAt: new Date(),
          },
        });
        campaigns += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error({ organisationId, adAccountId: account.id, date: v.date, error: message }, "ad campaign ingest failed for account");
      failed.push({ adAccountId: account.id, error: message });
    }
  }

  const result: CampaignIngestResult = { date: v.date, accounts: accounts.length, unsupported, campaigns, failed };
  if (failed.length > 0) throw new AdCampaignIngestError(result);
  return result;
}

export const CampaignSpendInput = z.object({
  from: IsoDate,
  to: IsoDate,
  /** One client's campaigns only. Omitted, every account in the organisation. */
  clientId: z.string().uuid().optional(),
});
export type CampaignSpendInput = z.input<typeof CampaignSpendInput>;

export interface CampaignSpend {
  campaignName: string;
  spendPence: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface CampaignSpendTotals {
  from: string;
  to: string;
  campaigns: CampaignSpend[];
  /** Every active account's spend over the period, campaign rows or not. The denominator for "how much did we place". */
  accountSpendPence: number;
  /** The sum of the campaign rows. Never more than `accountSpendPence` in practice, and the gap is what the screen admits to. */
  campaignSpendPence: number;
}

/**
 * Spend by campaign name over a period, plus the account-level total for the
 * same period so a caller can say what share of the money it could place.
 *
 * Grouped by name rather than by campaign id because a `utm_campaign` is a
 * name: two ids that ran under the same name are one campaign as far as the
 * ads on the page were concerned.
 */
export async function campaignSpend(db: Db, organisationId: string, input: CampaignSpendInput): Promise<CampaignSpendTotals> {
  const v = CampaignSpendInput.parse(input);
  const scope = (accountTable: typeof schema.adAccounts) =>
    v.clientId ? eq(accountTable.clientId, v.clientId) : undefined;

  const [campaigns, [totals]] = await Promise.all([
    db
      .select({
        campaignName: schema.adCampaignSnapshots.campaignName,
        spendPence: sql<number>`sum(${schema.adCampaignSnapshots.spendPence})`,
        impressions: sql<number>`sum(${schema.adCampaignSnapshots.impressions})`,
        clicks: sql<number>`sum(${schema.adCampaignSnapshots.clicks})`,
        conversions: sql<number>`sum(${schema.adCampaignSnapshots.conversions})`,
      })
      .from(schema.adCampaignSnapshots)
      .innerJoin(schema.adAccounts, eq(schema.adCampaignSnapshots.adAccountId, schema.adAccounts.id))
      .where(and(
        eq(schema.adCampaignSnapshots.organisationId, organisationId),
        gte(schema.adCampaignSnapshots.date, v.from),
        lte(schema.adCampaignSnapshots.date, v.to),
        scope(schema.adAccounts),
      ))
      .groupBy(schema.adCampaignSnapshots.campaignName)
      .orderBy(sql`sum(${schema.adCampaignSnapshots.spendPence}) desc`, schema.adCampaignSnapshots.campaignName),
    db
      .select({ spendPence: sql<number>`coalesce(sum(${schema.adMetricSnapshots.spendPence}), 0)` })
      .from(schema.adMetricSnapshots)
      .innerJoin(schema.adAccounts, eq(schema.adMetricSnapshots.adAccountId, schema.adAccounts.id))
      .where(and(
        eq(schema.adMetricSnapshots.organisationId, organisationId),
        gte(schema.adMetricSnapshots.date, v.from),
        lte(schema.adMetricSnapshots.date, v.to),
        scope(schema.adAccounts),
      )),
  ]);

  const rows = campaigns.map((row) => ({
    campaignName: row.campaignName,
    spendPence: Number(row.spendPence),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    conversions: Number(row.conversions),
  }));
  return {
    from: v.from,
    to: v.to,
    campaigns: rows,
    accountSpendPence: Number(totals?.spendPence ?? 0),
    campaignSpendPence: rows.reduce((sum, row) => sum + row.spendPence, 0),
  };
}
