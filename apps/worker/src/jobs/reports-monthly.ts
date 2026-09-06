import {
  REPORT_TIME_ZONE, ReportRefused, buildMonthlyReport, londonMonthPeriod, monthlyReportSendDecided,
  renderMonthlyReport, reportMonthName, requestMonthlyReportSend, zonedDateKey,
  type MonthlyReportDeps,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { sweep, throwOnSweepFailure, type SweepLogger } from "./sweep.js";

/**
 * The monthly account report: one document on the 1st, in place of the several
 * emails a client used to get.
 *
 * Three steps per client, in this order and for these reasons:
 *
 * 1. **Compile** — `buildMonthlyReport`, which is `buildClientReport` over the
 *    *London* month. The cron fires at 07:45 on the 1st, and in British Summer
 *    Time a UTC month starts at 01:00 local; a report headed "August" that ran
 *    on UTC bounds would take an hour of September in and leave an hour of
 *    July out.
 * 2. **Render** — the PDF, on the same headed paper as the proposal, the
 *    handover and the invoice. Only this process has Chromium, which is the
 *    whole reason the compile and the render are split.
 * 3. **Ask** — a `report_send` approval. Nothing here emails a client.
 *    Shoji reads the card, approves it, and `applyMonthlyReportSendDecision`
 *    publishes the report and queues the mail. That is the same gate the
 *    content report has had since it was built, deliberately reused rather
 *    than paralleled.
 *
 * The cron is registered at `45 7 1 * *` Europe/London — after `ads.ingest`
 * (06:30) has landed the last day of the month's spend, after
 * `invoices.check-overdue` (07:30), and after `content.report` (07:00),
 * because `collectContentStats` reads the row that job writes and the two
 * documents a client gets must not disagree about how many posts went out.
 */

export interface MonthlyReportsResult {
  /** The month reported on, as a London date: `2026-08-01`. */
  periodStart: string;
  monthName: string;
  /** Active clients this organisation had when the sweep ran. */
  clients: number;
  /** Reports written or rewritten. */
  reports: number;
  /** PDFs rendered and filed against a report this run. */
  rendered: number;
  /** `report_send` cards raised this run. */
  requested: number;
  /** Clients whose report for the period was already published, so left alone. */
  skipped: number;
  /** Clients whose report could not be built; the rest still were. */
  failed: number;
}

/** Injectable so a test can make exactly one client fail. */
export type ReportBuilder = typeof buildMonthlyReport;

export interface MonthlyReportsLogger extends SweepLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface MonthlyReportsOptions {
  now: Date;
  build?: ReportBuilder;
  /** Defaults to `renderPdf` inside `renderMonthlyReport`; a test passes a stub. */
  render?: MonthlyReportDeps["render"];
  logger?: MonthlyReportsLogger;
}

async function activeClients(db: Db, organisationId: string): Promise<{ id: string }[]> {
  return db.select({ id: schema.clients.id }).from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.status, "active"),
    isNull(schema.clients.deletedAt),
  ));
}

/**
 * Compiles, renders and asks about last month's report for every active client.
 *
 * Every client gets its own error boundary: one client whose report throws
 * (a deadlock on the upsert, a statement timeout on the uptime join, a browser
 * that would not start) must not cost the other eleven their month — this cron
 * only comes round again in thirty days. Failures are collected and re-thrown
 * once at the end so the job is still marked failed and retried; every step is
 * idempotent, so the retry rebuilds, re-renders a draft, and asks about
 * nothing it has already asked about.
 */
export async function runMonthlyReports(
  db: Db,
  organisationId: string,
  options: MonthlyReportsOptions,
): Promise<MonthlyReportsResult> {
  const logger = options.logger ?? console;
  const build = options.build ?? buildMonthlyReport;
  const clients = await activeClients(db, organisationId);
  const deps: MonthlyReportDeps = { render: options.render };

  // Derived from the clock rather than from the first client's row, so an
  // organisation with no clients still logs which month it swept.
  const period = londonMonthPeriod(options.now);
  const periodStart = zonedDateKey(period.start, REPORT_TIME_ZONE);
  const monthName = reportMonthName(period);
  let reports = 0;
  let rendered = 0;
  let requested = 0;
  let skipped = 0;

  const label = `monthly reports (${organisationId})`;
  const summary = await sweep(clients, { label, id: (client) => client.id, logger }, async (client) => {
    const built = await build(db, organisationId, { clientId: client.id, now: options.now, actorKind: "system" });

    // The upsert refuses to overwrite a published report and re-reads the
    // published row instead, so a "published" status back means this client's
    // report was NOT rebuilt — and a published report is one the client has
    // already been sent, so there is nothing left to render or ask about.
    if (built.report.status === "published") {
      skipped += 1;
      return;
    }
    reports += 1;

    await renderMonthlyReport(db, organisationId, { reportId: built.report.id, actorKind: "system" }, deps);
    rendered += 1;

    // A send Shoji has already decided is not asked about again: a rejection
    // leaves the report a draft, and a retry of this job must not put the same
    // card back in front of him.
    if (await monthlyReportSendDecided(db, organisationId, built.report.id)) return;
    try {
      await requestMonthlyReportSend(db, organisationId, { reportId: built.report.id, actorKind: "system" });
      requested += 1;
    } catch (error) {
      if (!(error instanceof ReportRefused)) throw error;
      // Both are business answers, not faults. `already_pending` is a card
      // still waiting; `no_recipient` is a client managed without an address,
      // which is worth a log line and nobody's pager.
      if (error.reason === "no_recipient") {
        logger.warn({ organisationId, clientId: client.id, reportId: built.report.id }, "monthly report has nobody to send to");
      }
    }
  });

  const result: MonthlyReportsResult = {
    periodStart, monthName, clients: clients.length, reports, rendered, requested, skipped, failed: summary.failed,
  };
  // Logged here, not by the caller: the throw below discards the return value,
  // and the failing run is the one case where the operator most needs to know
  // how many of the other clients did get a report.
  logger.info({ organisationId, ...result }, "monthly reports");
  throwOnSweepFailure(label, summary);
  return result;
}
