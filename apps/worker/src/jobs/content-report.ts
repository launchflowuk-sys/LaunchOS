import { CONTENT_REPORT_SEND_ACTION, ContentRefused, buildContentReport, parsePeriodKey, periodKeyFor, requestContentReportSend } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
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
  /** Send approvals raised this run; a report already sent, pending or decided is not asked about again. */
  requested: number;
  failed: number;
}

/** `2026-09` → `2026-08`. */
export function previousPeriodKey(periodKey: string): string {
  const [year, month] = parsePeriodKey(periodKey);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
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

/**
 * Whether the owner has already decided a send for this report. A rejection
 * leaves the report a draft, and a re-run of this job (a retry, or a manual
 * kick) must not put the same card back in front of them; a pending one is
 * `requestContentReportSend`'s own `already_pending` refusal.
 */
async function sendAlreadyDecided(db: Db, organisationId: string, reportId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(
    eq(schema.approvals.organisationId, organisationId),
    eq(schema.approvals.kind, CONTENT_REPORT_SEND_ACTION),
    sql`${schema.approvals.payload}->>'reportId' = ${reportId}`,
    ne(schema.approvals.status, "pending"),
  )).limit(1);
  return row !== undefined;
}

/**
 * On the 1st: builds last month's content report for every client who had
 * something published, and asks the owner to send it — a
 * `content_report_send` approval, whose card carries the summary and whose
 * request rings the owner's bell (and phone: `approval.requested` is urgent).
 * Approving it emails the client's portal users and marks the report sent;
 * see `applyContentReportSendDecision` in core.
 *
 * Re-running is safe: `buildContentReport` replaces a draft in place and
 * never touches a sent one; a report already sent is skipped; a send already
 * waiting is `already_pending`, which is expected and not counted; and a send
 * the owner already rejected is not asked about again.
 */
export async function runContentReports(db: Db, organisationId: string, options: ContentReportOptions): Promise<ContentReportResult> {
  const logger = options.logger ?? console;
  const periodKey = previousPeriodKey(periodKeyFor(options.now));
  const clients = await clientsWithPublishedContent(db, organisationId, periodKey);

  let reports = 0;
  let requested = 0;
  const label = `content reports (${organisationId})`;
  const summary = await sweep(clients, { label, id: (c) => c.clientId, logger }, async (client) => {
    const report = await buildContentReport(db, organisationId, { clientId: client.clientId, periodKey, actorKind: "system" });
    reports += 1;
    if (report.status === "sent" || (await sendAlreadyDecided(db, organisationId, report.id))) return;
    try {
      await requestContentReportSend(db, organisationId, { reportId: report.id, actorKind: "system" });
      requested += 1;
    } catch (error) {
      if (error instanceof ContentRefused && (error.reason === "already_pending" || error.reason === "already_sent")) return;
      throw error;
    }
  });

  const result: ContentReportResult = { periodKey, clients: clients.length, reports, requested, failed: summary.failed };
  logger.info({ organisationId, ...result }, "content reports");
  throwOnSweepFailure(label, summary);
  return result;
}
