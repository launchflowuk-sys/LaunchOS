import { date, doublePrecision, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { agentRuns } from "./agents.js";
import { clients } from "./clients.js";
import { messages } from "./support.js";

export const adPlatformEnum = pgEnum("ad_platform", ["google", "meta"]);
export const adAccountStatusEnum = pgEnum("ad_account_status", ["active", "paused", "disconnected"]);
export const adReportStatusEnum = pgEnum("ad_report_status", ["draft", "approved", "sent"]);

export const adAccounts = pgTable("ad_accounts", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  platform: adPlatformEnum("platform").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  currency: text("currency").default("GBP").notNull(),
  status: adAccountStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("ad_accounts_org_platform_external").on(t.organisationId, t.platform, t.externalId)]);

// Money is stored in whole pence; cpc_pence is fractional because a cost per
// click is routinely a fraction of a penny once averaged over a day.
export const adMetricSnapshots = pgTable("ad_metric_snapshots", {
  ...tenantColumns(),
  adAccountId: uuid("ad_account_id").notNull().references(() => adAccounts.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  spendPence: integer("spend_pence").default(0).notNull(),
  impressions: integer("impressions").default(0).notNull(),
  clicks: integer("clicks").default(0).notNull(),
  conversions: integer("conversions").default(0).notNull(),
  conversionValuePence: integer("conversion_value_pence").default(0).notNull(),
  cpcPence: doublePrecision("cpc_pence").default(0).notNull(),
  roas: doublePrecision("roas").default(0).notNull(),
}, (t) => [uniqueIndex("ad_metric_snapshots_account_date").on(t.adAccountId, t.date)]);

export const adReports = pgTable("ad_reports", {
  ...tenantColumns(),
  adAccountId: uuid("ad_account_id").notNull().references(() => adAccounts.id, { onDelete: "cascade" }),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  summaryMd: text("summary_md").notNull(),
  status: adReportStatusEnum("status").default("draft").notNull(),
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  sentMessageId: uuid("sent_message_id").references(() => messages.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});
