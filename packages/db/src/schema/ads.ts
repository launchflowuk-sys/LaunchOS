import { date, doublePrecision, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

/**
 * The same day, cut by campaign.
 *
 * `ad_metric_snapshots` answers "what did this account spend"; nothing in it
 * can answer "what did the spring-offer campaign cost per lead", because a
 * lead carries a `utm_campaign` and an account carries several campaigns. So
 * the ingest asks the provider for the campaign breakdown as well as the
 * account total, and the cost-per-lead join is a real join rather than an
 * apportioning rule invented to cover a gap.
 *
 * Deliberately not a replacement for the account table: the account row stays
 * the source of truth for a client's spend (it includes campaigns that were
 * deleted between the day and the fetch, which the campaign query drops), and
 * the cost-per-lead screen says out loud how much of the account's spend it
 * managed to place against a campaign.
 *
 * `campaign_name` is denormalised on purpose — it is what the visitor's
 * `utm_campaign` is matched against, and a campaign renamed in Google should
 * not silently rewrite last month's figures.
 */
export const adCampaignSnapshots = pgTable("ad_campaign_snapshots", {
  ...tenantColumns(),
  adAccountId: uuid("ad_account_id").notNull().references(() => adAccounts.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  campaignExternalId: text("campaign_external_id").notNull(),
  campaignName: text("campaign_name").notNull(),
  spendPence: integer("spend_pence").default(0).notNull(),
  impressions: integer("impressions").default(0).notNull(),
  clicks: integer("clicks").default(0).notNull(),
  conversions: integer("conversions").default(0).notNull(),
  conversionValuePence: integer("conversion_value_pence").default(0).notNull(),
}, (t) => [
  uniqueIndex("ad_campaign_snapshots_account_date_campaign").on(t.adAccountId, t.date, t.campaignExternalId),
  index("ad_campaign_snapshots_org_date").on(t.organisationId, t.date),
]);

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
