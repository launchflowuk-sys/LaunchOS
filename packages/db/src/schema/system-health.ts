import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The system watching itself. Deliberately **global** — no `organisation_id`:
 * there is one worker process and one web process for the whole deployment,
 * and "the worker has not checked in" is true for every tenant at once.
 *
 * One row per `name`: `worker` is written every minute by the worker's
 * heartbeat loop; `worker-down-alert` remembers which outage the owner has
 * already been told about; `system-errors` carries the per-signature throttle
 * for `system.error` notifications. `details` is whatever the writer wants to
 * show — queue depths, the last job, uptime.
 */
export const systemHeartbeats = pgTable("system_heartbeats", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
