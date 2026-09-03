import { boolean, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { sites } from "./sites.js";

export const channelEnum = pgEnum("channel", ["portal", "email", "whatsapp", "internal"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["open", "closed"]);
export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound", "internal"]);
export const actorKindEnum = pgEnum("actor_kind", ["user", "client", "agent", "system"]);
export const ticketCategoryEnum = pgEnum("ticket_category", ["hosting", "dns", "content", "email", "ads", "billing", "other"]);
export const severityEnum = pgEnum("severity", ["low", "medium", "high", "critical"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["open", "triaged", "in_progress", "waiting_client", "resolved", "closed"]);
export const ticketSourceEnum = pgEnum("ticket_source", ["portal", "email", "agent", "monitor", "manual"]);
export const ticketEventKindEnum = pgEnum("ticket_event_kind", ["created", "status_changed", "assigned", "note", "escalated", "agent_action"]);

export const conversations = pgTable("conversations", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  subject: text("subject").notNull(),
  channel: channelEnum("channel").default("internal").notNull(),
  status: conversationStatusEnum("status").default("open").notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
});

export const messages = pgTable("messages", {
  ...tenantColumns(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  direction: messageDirectionEnum("direction").notNull(),
  authorKind: actorKindEnum("author_kind").notNull(),
  authorId: text("author_id"),
  body: text("body").notNull(),
  bodyHtml: text("body_html"),
  externalId: text("external_id").unique(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export const tickets = pgTable("tickets", {
  ...tenantColumns(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  subject: text("subject").notNull(),
  category: ticketCategoryEnum("category"),
  severity: severityEnum("severity").default("medium").notNull(),
  status: ticketStatusEnum("status").default("open").notNull(),
  assignedUserId: text("assigned_user_id"),
  escalated: boolean("escalated").default(false).notNull(),
  escalationReason: text("escalation_reason"),
  source: ticketSourceEnum("source").default("manual").notNull(),
});

export const ticketEvents = pgTable("ticket_events", {
  ...tenantColumns(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  kind: ticketEventKindEnum("kind").notNull(),
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorId: text("actor_id"),
  data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
});
