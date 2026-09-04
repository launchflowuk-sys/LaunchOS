import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
export const messageStatusEnum = pgEnum("message_status", ["queued", "sent", "failed", "received"]);

export interface StoredAttachment { name: string; contentType: string; size: number; url: string }
export interface TicketTriage { category: string; severity: string; summary: string; suggestedFix: string; confidence: number }

export const conversations = pgTable("conversations", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  subject: text("subject").notNull(),
  channel: channelEnum("channel").default("internal").notNull(),
  status: conversationStatusEnum("status").default("open").notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  // No FK to tickets: tickets already references conversations, and a second
  // FK the other way is a cycle Drizzle cannot order. Kept in sync by
  // ingestInboundEmail and createTicket, which write both sides in one tx.
  ticketId: uuid("ticket_id"),
  externalThreadKey: text("external_thread_key"),
  participantEmail: text("participant_email"),
}, (t) => [
  uniqueIndex("conversations_org_thread_key").on(t.organisationId, t.externalThreadKey),
]);

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
  fromEmail: text("from_email"),
  toEmail: text("to_email"),
  subject: text("subject"),
  rawHeaders: jsonb("raw_headers").$type<Record<string, string>>().default({}).notNull(),
  attachments: jsonb("attachments").$type<StoredAttachment[]>().default([]).notNull(),
  // Null for internal notes: queued/sent/failed/received describe email only.
  status: messageStatusEnum("status"),
}, (t) => [
  // Postgres does not index a foreign key for you. Every thread read and the
  // Inbox list's "newest message" subquery filter on conversation_id and order
  // by created_at, so both are one index lookup rather than a scan of messages.
  index("messages_conversation_created").on(t.conversationId, t.createdAt),
]);

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
  // Whether the client may see this ticket in their portal. Default false:
  // an internal ticket (the overdue sweep, an agent's `tickets_create`, a
  // staff-raised case) is agency work, and the client's own thread would
  // render empty because its opening body is an internal note. Set true by
  // `createTicket` for the two sources the client originated — portal and
  // email — and toggled by staff to share one deliberately.
  clientVisible: boolean("client_visible").default(false).notNull(),
  firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  triage: jsonb("triage").$type<TicketTriage | null>(),
});

export const ticketEvents = pgTable("ticket_events", {
  ...tenantColumns(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  kind: ticketEventKindEnum("kind").notNull(),
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorId: text("actor_id"),
  data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
});
