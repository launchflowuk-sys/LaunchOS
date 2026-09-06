import { DOCUMENT_MARGIN, renderDocumentHtml, renderPdf, type RenderPdfInput } from "@launchos/channels/pdf";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { storeDocument, type DocumentKind, type DocumentRow } from "../documents/store-document.js";
import { zonedParts, zonedTimeToUtc } from "../meetings/time.js";
import { REPORT_TIME_ZONE, buildClientReport, type ReportActor, type ReportPeriod } from "./build-client-report.js";
import { documentBodyFromMarkdown } from "./markdown-document.js";

/**
 * The monthly account report: one document on the 1st, in place of the several
 * emails a client used to get.
 *
 * **It is the client report, not a second one.** `buildClientReport` compiles
 * the month and writes `client_reports`; this module chooses the period the
 * way the business means it, renders that row onto the shared letterhead, and
 * files the PDF against the same row. There is no parallel pipeline, no second
 * set of numbers and no second place a month can be described — which matters
 * because the admin page, the portal and the PDF all have to agree about
 * August for ever, not just on the 1st of September.
 *
 * What this file added on top of the existing machinery is exactly three
 * things: the London month (`monthPeriod` is UTC, and a report about "August"
 * that starts at 01:00 on 1 August British Summer Time is wrong at both ends),
 * the render, and the `document_id` on the row.
 */

export const MONTHLY_REPORT_DOCUMENT_KIND: DocumentKind = "monthly_report";
/** `documents.subject_type` — the subject is the `client_reports` row. */
export const MONTHLY_REPORT_SUBJECT_TYPE = "client_report";
/** The audit target type the render is recorded under. */
export const CLIENT_REPORT_TARGET_TYPE = "client_report";
/** Re-exported so a caller has one import for "the month, as this business reads it". */
export { REPORT_TIME_ZONE };
type ClientReportRow = typeof schema.clientReports.$inferSelect;

/**
 * The calendar month that ended before `now`, in Europe/London.
 *
 * The existing `monthPeriod` is the same idea in UTC, and for eight months of
 * the year the two agree exactly. They disagree in British Summer Time, where
 * a UTC month boundary falls at 01:00 local: a report built at 07:45 on 1
 * September would take an hour of September's uptime into August's figure and
 * leave an hour of July's out. One hour of checks is not much; a period that
 * does not mean what the heading says is.
 */
export function londonMonthPeriod(now: Date): ReportPeriod {
  const here = zonedParts(now, REPORT_TIME_ZONE);
  const end = zonedTimeToUtc({ year: here.year, month: here.month, day: 1 }, REPORT_TIME_ZONE);
  const previous = here.month === 1 ? { year: here.year - 1, month: 12 } : { year: here.year, month: here.month - 1 };
  const start = zonedTimeToUtc({ year: previous.year, month: previous.month, day: 1 }, REPORT_TIME_ZONE);
  return { start, end };
}

/** "August 2026" — how the month reads in a heading, an email and a subject line. */
export function reportMonthName(period: ReportPeriod): string {
  const parts = zonedParts(period.start, REPORT_TIME_ZONE);
  return new Date(Date.UTC(parts.year, parts.month - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The reference printed in the footer: `R-2026-08-1A2B3C4D`. */
export function monthlyReportReference(report: Pick<ClientReportRow, "periodStart" | "clientId">): string {
  return `R-${report.periodStart.slice(0, 7)}-${report.clientId.slice(0, 8).toUpperCase()}`;
}

/** The document's title, at the top of page one and in the PDF's own metadata. */
export function monthlyReportTitle(monthName: string): string {
  return `Your account — ${monthName}`;
}

export interface MonthlyReportDocumentInput {
  report: ClientReportRow;
  clientName: string;
  monthName: string;
}

/**
 * The report as one page of headed paper.
 *
 * The body is the stored `summary_md`, printed. Nothing is recomputed here and
 * no figure is formatted twice: if the row says 99.8% uptime, that is what the
 * PDF says, because it is literally the same string.
 */
export function monthlyReportDocumentHtml(input: MonthlyReportDocumentInput): string {
  const { report } = input;
  return renderDocumentHtml({
    title: monthlyReportTitle(input.monthName),
    subtitle: `Prepared for ${input.clientName}`,
    meta: [
      { label: "Reference", value: monthlyReportReference(report) },
      { label: "Period", value: `${report.periodStart} to ${report.periodEnd}` },
    ],
    bodyHtml: documentBodyFromMarkdown(report.summaryMd),
    closingNote: "This is everything we did for you last month. Reply to the email this came with and it goes straight to Shoji.",
  });
}

/** The render request: the HTML, A4, and the reference in the footer. */
export function monthlyReportRenderInput(input: MonthlyReportDocumentInput): RenderPdfInput {
  return {
    html: monthlyReportDocumentHtml(input),
    format: "A4",
    margin: DOCUMENT_MARGIN,
    footerReference: monthlyReportReference(input.report),
  };
}

/** What rendering a monthly report needs from the outside world. */
export interface MonthlyReportDeps {
  render?: ((input: RenderPdfInput) => Promise<Uint8Array<ArrayBuffer>>) | undefined;
}

export const BuildMonthlyReportInput = z.object({
  clientId: z.string().uuid(),
  /** Anchors the period: the report is for the month before this instant. Defaults to now. */
  now: z.date().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type BuildMonthlyReportInput = z.input<typeof BuildMonthlyReportInput>;

export interface MonthlyReportResult {
  report: ClientReportRow;
  period: ReportPeriod;
  monthName: string;
}

/**
 * Compiles last month for one client — `buildClientReport` with the London
 * period, and nothing else.
 *
 * Safe to run twice: the upsert behind it replaces a draft and refuses to
 * touch a published row, so the cron re-running on the 1st cannot rewrite a
 * report a client has already been sent.
 */
export async function buildMonthlyReport(db: Db, organisationId: string, input: BuildMonthlyReportInput): Promise<MonthlyReportResult> {
  const v = BuildMonthlyReportInput.parse(input);
  const period = londonMonthPeriod(v.now ?? new Date());
  const actor: ReportActor = { actorKind: v.actorKind, ...(v.actorId ? { actorId: v.actorId } : {}) };
  const report = await buildClientReport(db, organisationId, v.clientId, period, actor);
  return { report, period, monthName: reportMonthName(period) };
}

export const RenderMonthlyReportInput = z.object({
  reportId: z.string().uuid(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type RenderMonthlyReportInput = z.input<typeof RenderMonthlyReportInput>;

export interface RenderMonthlyReportResult {
  report: ClientReportRow;
  document: DocumentRow;
  monthName: string;
}

/**
 * Renders a compiled report and files the PDF against its row.
 *
 * A **draft** is re-rendered on every call, because a draft is still being
 * corrected and the document must follow the row. A **published** report keeps
 * the document it was published with: that is the file the client was sent,
 * and its digest is the reason `documents.sha256` exists.
 *
 * The render happens outside a transaction, as everywhere else: a browser call
 * must not hold a database lock.
 */
export async function renderMonthlyReport(
  db: Db,
  organisationId: string,
  input: RenderMonthlyReportInput,
  deps?: MonthlyReportDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RenderMonthlyReportResult> {
  const v = RenderMonthlyReportInput.parse(input);
  const [report] = await db.select().from(schema.clientReports)
    .where(and(
      eq(schema.clientReports.id, v.reportId),
      eq(schema.clientReports.organisationId, organisationId),
      isNull(schema.clientReports.deletedAt),
    ));
  if (!report) throw new Error(`client report ${v.reportId} not found in organisation`);

  const monthName = reportMonthName({
    start: new Date(`${report.periodStart}T12:00:00Z`),
    end: new Date(`${report.periodEnd}T12:00:00Z`),
  });

  if (report.status === "published" && report.documentId) {
    const [existing] = await db.select().from(schema.documents)
      .where(and(eq(schema.documents.id, report.documentId), eq(schema.documents.organisationId, organisationId)));
    if (existing) return { report, document: existing, monthName };
  }

  const [client] = await db.select({ name: schema.clients.name }).from(schema.clients)
    .where(and(eq(schema.clients.id, report.clientId), eq(schema.clients.organisationId, organisationId)));
  const render = deps?.render ?? ((request: RenderPdfInput) => renderPdf(request));
  const bytes = await render(monthlyReportRenderInput({ report, clientName: client?.name ?? "your business", monthName }));

  const document = await storeDocument(db, organisationId, {
    kind: MONTHLY_REPORT_DOCUMENT_KIND,
    title: monthlyReportTitle(monthName),
    reference: monthlyReportReference(report),
    clientId: report.clientId,
    subjectType: MONTHLY_REPORT_SUBJECT_TYPE,
    subjectId: report.id,
    bytes,
    actorKind: v.actorKind,
    ...(v.actorId ? { actorId: v.actorId } : {}),
  }, env);

  const [after] = await db.update(schema.clientReports)
    .set({ documentId: document.id, updatedAt: new Date() })
    .where(and(eq(schema.clientReports.id, report.id), eq(schema.clientReports.organisationId, organisationId)))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "client_report.rendered",
    targetType: CLIENT_REPORT_TARGET_TYPE, targetId: report.id, before: report, after,
  });

  return { report: after ?? report, document, monthName };
}
