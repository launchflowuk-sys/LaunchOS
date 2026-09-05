import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { approvals } from "./agents.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { tasks } from "./tasks.js";

/**
 * The content engine: what LaunchOS writes, gets approved, schedules and
 * publishes for a client each month, and how it proves it did.
 *
 * A *brief* is the per-client voice the writer works from. A *channel* is a
 * place a post can land (a Facebook Page, an Instagram account, the blog on
 * one of the client's sites, a Google Business Profile location). An *item*
 * is one post moving through draft → approval → schedule → publish. An
 * *asset* is an image the client or staff uploaded, or one that was generated.
 */
export const contentChannelEnum = pgEnum("content_channel", ["facebook", "instagram", "blog", "gbp"]);
export const contentKindEnum = pgEnum("content_kind", ["social_post", "blog_post", "gbp_update"]);
export const contentStatusEnum = pgEnum("content_status", [
  "draft", "awaiting_approval", "approved", "scheduled", "publishing", "published", "failed", "rejected", "cancelled",
]);
export const contentSourceEnum = pgEnum("content_source", ["agent", "staff", "client"]);
export const contentAssetSourceEnum = pgEnum("content_asset_source", ["client", "staff", "generated"]);
export const contentReportStatusEnum = pgEnum("content_report_status", ["draft", "approved", "sent"]);

export type ContentChannel = (typeof contentChannelEnum.enumValues)[number];
export type ContentKind = (typeof contentKindEnum.enumValues)[number];
export type ContentStatus = (typeof contentStatusEnum.enumValues)[number];
export type ContentSource = (typeof contentSourceEnum.enumValues)[number];
export type ContentAssetSource = (typeof contentAssetSourceEnum.enumValues)[number];
export type ContentReportStatus = (typeof contentReportStatusEnum.enumValues)[number];

export const contentBriefs = pgTable("content_briefs", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  tone: text("tone"),
  audience: text("audience"),
  services: text("services"),
  offers: text("offers"),
  area: text("area"),
  doNotSay: text("do_not_say"),
  notes: text("notes"),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("content_briefs_org_client").on(t.organisationId, t.clientId)]);

export const contentChannels = pgTable("content_channels", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  channel: contentChannelEnum("channel").notNull(),
  /** Facebook Page id, Instagram Business user id, LaunchOS site id for the blog, GBP location id. */
  externalId: text("external_id").notNull(),
  displayName: text("display_name"),
  enabled: boolean("enabled").default(true).notNull(),
}, (t) => [uniqueIndex("content_channels_org_client_channel").on(t.organisationId, t.clientId, t.channel)]);

/**
 * What `content_items.metadata` carries. `slot` is the planner's idempotency
 * key (the nth item for this channel in this month); `sequence` is the item's
 * position across every channel of the month, which is what the recurring
 * task was numbered by; `publishAttempts` is how many times the publish job
 * has tried and failed.
 */
export interface ContentItemMetadata {
  slot?: number;
  sequence?: number;
  publishAttempts?: number;
  [key: string]: unknown;
}

export const contentItems = pgTable("content_items", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  channel: contentChannelEnum("channel").notNull(),
  kind: contentKindEnum("kind").notNull(),
  status: contentStatusEnum("status").default("draft").notNull(),
  /** `YYYY-MM` — the month this item belongs to, in Europe/London. */
  periodKey: text("period_key").notNull(),
  title: text("title"),
  body: text("body"),
  imageUrl: text("image_url"),
  imagePrompt: text("image_prompt"),
  linkUrl: text("link_url"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  externalId: text("external_id"),
  externalUrl: text("external_url"),
  lastError: text("last_error"),
  source: contentSourceEnum("source").default("staff").notNull(),
  suggestedByUserId: text("suggested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
}, (t) => [
  index("content_items_org_client_period").on(t.organisationId, t.clientId, t.periodKey),
  index("content_items_org_status_scheduled").on(t.organisationId, t.status, t.scheduledFor),
  // The planner is idempotent by (client, month, channel, slot): a re-run tops
  // up what is missing instead of doubling the month. Hand-made items and
  // client suggestions carry no slot and are unaffected.
  uniqueIndex("content_items_planned_slot")
    .on(t.organisationId, t.clientId, t.periodKey, t.channel, sql`(${t.metadata} ->> 'slot')`)
    .where(sql`${t.metadata} ->> 'slot' is not null`),
]);

export const contentAssets = pgTable("content_assets", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  /** Relative to STORAGE_DIR. */
  path: text("path").notNull(),
  mime: text("mime").notNull(),
  alt: text("alt"),
  source: contentAssetSourceEnum("source").default("staff").notNull(),
  uploadedByUserId: text("uploaded_by_user_id").references(() => user.id, { onDelete: "set null" }),
}, (t) => [index("content_assets_org_client").on(t.organisationId, t.clientId)]);

/** One published item as it appears in a month's content report. */
export interface ContentReportItem {
  id: string;
  channel: ContentChannel;
  kind: ContentKind;
  title: string | null;
  publishedAt: string;
  externalUrl: string | null;
}

/** The numbers behind a monthly content report, rendered above the Markdown. */
export interface ContentReportStats {
  published: number;
  planned: number;
  byChannel: Record<ContentChannel, number>;
  items: ContentReportItem[];
}

/**
 * A month's proof of work, separate from `client_reports` because the two
 * cover different things for the same client and period and one row per
 * (client, period) is all `client_reports` allows. Built as a draft; the
 * send flow (Phase C3) approves and sends it the way ad reports go out.
 */
export const contentReports = pgTable("content_reports", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  periodKey: text("period_key").notNull(),
  summaryMd: text("summary_md").notNull(),
  stats: jsonb("stats").$type<Partial<ContentReportStats>>().default({}).notNull(),
  status: contentReportStatusEnum("status").default("draft").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [uniqueIndex("content_reports_org_client_period").on(t.organisationId, t.clientId, t.periodKey)]);
