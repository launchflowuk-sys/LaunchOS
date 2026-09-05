import { buildContentReport, monthName, notifyOwner, parsePeriodKey, periodKeyFor } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentReportStats } from "@launchos/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { sweep, throwOnSweepFailure, type SweepLogger } from "./sweep.js";

export interface ContentReportLogger extends SweepLogger {
  info(...args: unknown[]): void;
}

export interface ContentReportOptions {
  now: Date;
  logger?: ContentReportLogger;
}

export interface ContentReportResult {
  /** The month reported on: the one before `now`, in Europe/London. */
  periodKey: string;
  /** Clients with at least one published item in that month. */
  clients: number;
  reports: number;
  /** Owner notifications raised this run; a report already announced is not announced again. */
  notified: number;
  failed: number;
}

/** The notification kind the bell shows, and the key that stops a second one for the same report. */
export const CONTENT_REPORT_NOTIFICATION_KIND = "content_report.built";

/** `2026-09` → `2026-08`. */
export function previousPeriodKey(periodKey: string): string {
  const [year, month] = parsePeriodKey(periodKey);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** Where the owner is sent to read it. C4 owns the page; the query is the filter its list takes. */
export function contentReportLink(clientId: string, periodKey: string): string {
  return `/content?client=${clientId}&period=${periodKey}`;
}

async function clientsWithPublishedContent(db: Db, organisationId: string, periodKey: string): Promise<{ clientId: string; name: string }[]> {
  const rows = await db
    .selectDistinct({ clientId: schema.contentItems.clientId, name: schema.clients.name })
    .from(schema.contentItems)
    .innerJoin(schema.clients, eq(schema.contentItems.clientId, schema.clients.id))
    .where(and(
      eq(schema.contentItems.organisationId, organisationId),
      eq(schema.contentItems.periodKey, periodKey),
      eq(schema.contentItems.status, "published"),
      isNull(schema.contentItems.deletedAt),
    ));
  return rows;
}

async function alreadyAnnounced(db: Db, organisationId: string, link: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.notifications.id }).from(schema.notifications).where(and(
    eq(schema.notifications.organisationId, organisationId),
    eq(schema.notifications.kind, CONTENT_REPORT_NOTIFICATION_KIND),
    eq(schema.notifications.link, link),
  )).limit(1);
  return row !== undefined;
}

/**
 * On the 1st: builds last month's content report for every client who had
 * something published, and tells the owner it is ready.
 *
 * Sending it to the client is deliberately not here. The ad-report send flow
 * is bound to `ad_reports` (`sendAdReport` ships an approved `ad_reports`
 * row), and `content_reports` has `approved`/`sent` columns but no service
 * behind them yet — that service is core's to add, and this phase does not
 * own core. Until it exists the owner gets a bell notification with a link to
 * the month, once per report: the summary is in the admin portal, and the
 * client's portal already shows every published post with its link.
 *
 * Re-running is safe: `buildContentReport` replaces a draft in place and
 * never touches a sent one, and the notification is skipped when the same
 * report has already been announced.
 */
export async function runContentReports(db: Db, organisationId: string, options: ContentReportOptions): Promise<ContentReportResult> {
  const logger = options.logger ?? console;
  const periodKey = previousPeriodKey(periodKeyFor(options.now));
  const clients = await clientsWithPublishedContent(db, organisationId, periodKey);

  let reports = 0;
  let notified = 0;
  const label = `content reports (${organisationId})`;
  const summary = await sweep(clients, { label, id: (c) => c.clientId, logger }, async (client) => {
    const report = await buildContentReport(db, organisationId, { clientId: client.clientId, periodKey, actorKind: "system" });
    reports += 1;
    const link = contentReportLink(client.clientId, periodKey);
    if (report.status === "sent" || (await alreadyAnnounced(db, organisationId, link))) return;
    const stats = report.stats as ContentReportStats;
    await notifyOwner(db, organisationId, {
      kind: CONTENT_REPORT_NOTIFICATION_KIND,
      title: `Content report ready: ${client.name}, ${monthName(periodKey)}`,
      body: `${stats.published} of ${stats.planned} planned posts published. Review it and share it with the client.`,
      link,
    });
    notified += 1;
  });

  const result: ContentReportResult = { periodKey, clients: clients.length, reports, notified, failed: summary.failed };
  logger.info({ organisationId, ...result }, "content reports");
  throwOnSweepFailure(label, summary);
  return result;
}
