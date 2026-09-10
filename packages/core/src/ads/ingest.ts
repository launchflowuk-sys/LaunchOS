import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { AdsAdapter } from "@launchos/integrations";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
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
  /**
   * Every failure was the provider refusing our credentials outright.
   *
   * Separated from ordinary failure because the response has to be different:
   * a rate limit or an outage is worth retrying in ten minutes, a deleted
   * OAuth client is not. Retrying that is noise until somebody goes and makes
   * new credentials.
   */
  credentialsRejected: boolean;
}

/**
 * OAuth failures that will never come good on their own.
 *
 * Google answers all of these with a 401 that looks like any other, so the
 * difference is in the body. `deleted_client` means the OAuth client is gone
 * from the console; `invalid_grant` means the refresh token has been revoked
 * or expired. Both need a person in Google Cloud Console, and neither is
 * improved by asking again in ten minutes.
 */
const PERMANENT_AUTH_CODES = [
  "deleted_client",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "access_denied",
] as const;

export function isPermanentAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return PERMANENT_AUTH_CODES.some((code) => lower.includes(code));
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
      // The platform travels with the id so the multi-platform adapter reads
      // Google accounts from Google and Meta from Meta without guessing from
      // the id's shape. Single-platform adapters ignore it.
      const metrics = await ads.fetchDailyMetrics(account.externalId, v.date, account.platform);
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
  const credentialsRejected =
    failed.length > 0 && failed.every((failure) => isPermanentAuthFailure(failure.error));
  const result: IngestResult = { date: v.date, accounts: accounts.length, snapshots, failed, credentialsRejected };

  if (credentialsRejected) {
    // Deliberately not thrown. Throwing makes pg-boss retry, and this is the
    // one failure a retry cannot help — it repeated every ten minutes for a
    // day and buried everything else in the log. Told once, plainly, with what
    // to actually do about it.
    await notifyOncePerDay(db, organisationId, {
      kind: "ads.credentials_rejected",
      title: "Google Ads has stopped working",
      body:
        "Google is refusing our credentials, so ad figures have stopped updating. " +
        "The OAuth client or its refresh token needs replacing in Google Cloud Console — " +
        "nothing here can fix it. Existing figures are safe.",
      link: "/ads",
    });
    return result;
  }

  if (failed.length > 0) throw new AdIngestError(result);
  return result;
}

/**
 * Rings the bell at most once a day for a condition that persists.
 *
 * A standing fault should say so once, not once per sweep. Anything more and
 * the bell becomes something to ignore, which costs more than the fault does.
 */
async function notifyOncePerDay(
  db: Db,
  organisationId: string,
  input: { kind: string; title: string; body: string; link: string },
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.kind, input.kind),
        gte(schema.notifications.createdAt, since),
      ),
    )
    .limit(1);
  if (recent) return;
  await notifyOwner(db, organisationId, input).catch(() => undefined);
}
