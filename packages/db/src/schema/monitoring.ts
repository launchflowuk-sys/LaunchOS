import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { sites } from "./sites.js";
import { severityEnum, tickets } from "./support.js";

export const monitorKindEnum = pgEnum("monitor_kind", ["http", "ssl", "resource"]);
export const incidentStatusEnum = pgEnum("incident_status", ["open", "acknowledged", "resolved"]);

export const monitors = pgTable("monitors", {
  ...tenantColumns(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  kind: monitorKindEnum("kind").default("http").notNull(),
  target: text("target").notNull(),
  intervalSeconds: integer("interval_seconds").default(60).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
});

export const uptimeChecks = pgTable("uptime_checks", {
  ...tenantColumns(),
  monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  ok: boolean("ok").notNull(),
  statusCode: integer("status_code"),
  latencyMs: integer("latency_ms"),
  error: text("error"),
}, (t) => [index("uptime_checks_monitor_time").on(t.monitorId, t.checkedAt)]);

export const incidents = pgTable("incidents", {
  ...tenantColumns(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  monitorId: uuid("monitor_id").references(() => monitors.id, { onDelete: "set null" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  status: incidentStatusEnum("status").default("open").notNull(),
  severity: severityEnum("severity").default("high").notNull(),
  title: text("title").notNull(),
  summaryMd: text("summary_md"),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  agentRunId: uuid("agent_run_id"),
});
