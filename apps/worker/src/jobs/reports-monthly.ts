import { buildClientReport, monthPeriod } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { sweep, throwOnSweepFailure, type SweepLogger } from "./sweep.js";

export interface MonthlyReportsResult {
  /** Active clients this organisation had when the sweep ran. */
  clients: number;
  /** Reports actually written or rewritten. */
  reports: number;
  /** Clients whose report for the period was already published, so left alone. */
  skipped: number;
  /** Clients whose report could not be built; the rest still were. */
  failed: number;
  periodStart: string;
}

/** Injectable so a test can make exactly one client fail. */
export type ReportBuilder = typeof buildClientReport;

export interface MonthlyReportsOptions {
  now: Date;
  build?: ReportBuilder;
  logger?: SweepLogger;
}

/**
 * Drafts last month's report for every active client. Runs on the 1st, after
 * `ads.ingest` has landed the final day of the month's ad metrics.
 *
 * Every client gets its own error boundary: one client whose report throws
 * (a deadlock on the upsert, a statement timeout on the uptime join) must not
 * cost the other eleven their month — this cron only comes round again in
 * thirty days. Failures are collected and re-thrown once at the end so the job
 * is still marked failed and retried; rebuilding is idempotent.
 */
export async function runMonthlyReports(
  db: Db,
  organisationId: string,
  options: MonthlyReportsOptions,
): Promise<MonthlyReportsResult> {
  const build = options.build ?? buildClientReport;
  const period = monthPeriod(options.now);
  const clients = await db.select({ id: schema.clients.id }).from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.status, "active"),
    isNull(schema.clients.deletedAt),
  ));

  let reports = 0;
  let skipped = 0;
  const summary = await sweep(
    clients,
    {
      label: `monthly reports (${organisationId})`,
      id: (client) => client.id,
      ...(options.logger && { logger: options.logger }),
    },
    async (client) => {
      const row = await build(db, organisationId, client.id, period);
      // The upsert refuses to overwrite a published report and re-reads the
      // published row instead, so a "published" status back means this client's
      // report was NOT rebuilt. Counting it as one would be a lie.
      if (row.status === "published") skipped += 1;
      else reports += 1;
    },
  );

  const result: MonthlyReportsResult = {
    clients: clients.length,
    reports,
    skipped,
    failed: summary.failed,
    periodStart: period.start.toISOString().slice(0, 10),
  };
  throwOnSweepFailure(`monthly reports (${organisationId})`, summary);
  return result;
}
