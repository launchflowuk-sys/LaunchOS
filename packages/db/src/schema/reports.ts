import { date, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { documents } from "./documents.js";

export const clientReportStatusEnum = pgEnum("client_report_status", ["draft", "published"]);

/** The numbers behind a monthly client report, rendered above the Markdown. */
export interface ClientReportStats {
  tasksDone: number;
  tasksOpen: number;
  uptimePercent: number | null;
  ticketsOpened: number;
  ticketsResolved: number;
  ads: { spendPence: number; clicks: number; conversions: number; roas: number } | null;
  /**
   * The four figures the monthly account report added, all optional so every
   * row written before it — and every reader of one — is unaffected.
   *
   * They are on `client_reports` rather than in a second table because the
   * monthly report *is* the client report, compiled into one document. A
   * parallel row would mean two records of the same month that could disagree.
   *
   * `null` and "absent" mean different things and both are kept: `content:
   * null` is "no content report was built for this month", while
   * `content: { published: 0 }` is "we built one and nothing went out".
   */
  incidents?: { opened: number; resolved: number; openAtPeriodEnd: number } | null;
  content?: { published: number; planned: number } | null;
  /** How the month's resolved cases were rated, 1-5. `null` when nobody rated one. */
  satisfaction?: { responses: number; averageScore: number } | null;
  /** Money actually received in the period, however it arrived. */
  payments?: { received: number; receivedPence: number } | null;
  invoices: { issued: number; paidPence: number; outstandingPence: number };
  /**
   * The ISO currency every `*Pence` figure above is denominated in — read from
   * the client's own ad accounts and invoices rather than assumed. `null` when
   * that is genuinely ambiguous: the client has nothing billed or advertised
   * in the period, or has more than one currency in play and the totals above
   * are therefore sums of unlike things. A reader must not be shown a currency
   * symbol we cannot stand behind, so `null` means "do not label these".
   */
  currency: string | null;
}

export const clientReports = pgTable("client_reports", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  summaryMd: text("summary_md").notNull(),
  stats: jsonb("stats").$type<Partial<ClientReportStats>>().default({}).notNull(),
  status: clientReportStatusEnum("status").default("draft").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  /**
   * The month as one PDF, on the same headed paper as the proposal and the
   * invoice. Rendered from this row, so the document and the record can never
   * say different things; re-rendering a draft replaces it, and the document
   * a published report points at is the one the client was sent.
   */
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("client_reports_client_period").on(t.organisationId, t.clientId, t.periodStart)]);
