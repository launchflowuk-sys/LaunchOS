import { date, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

export const clientReportStatusEnum = pgEnum("client_report_status", ["draft", "published"]);

/** The numbers behind a monthly client report, rendered above the Markdown. */
export interface ClientReportStats {
  tasksDone: number;
  tasksOpen: number;
  uptimePercent: number | null;
  ticketsOpened: number;
  ticketsResolved: number;
  ads: { spendPence: number; clicks: number; conversions: number; roas: number } | null;
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
}, (t) => [uniqueIndex("client_reports_client_period").on(t.organisationId, t.clientId, t.periodStart)]);
