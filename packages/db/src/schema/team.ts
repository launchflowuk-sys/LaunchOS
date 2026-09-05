import { sql } from "drizzle-orm";
import { date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { tickets } from "./support.js";
import { tasks } from "./tasks.js";

/**
 * One stretch of a team member's time. A plain clock-in is an entry with no
 * task and no ticket; a timer started from a task or case page carries the
 * link. `ended_at` is null while the entry is running, and the partial unique
 * index below is what makes "one running entry per person" a fact the
 * database enforces rather than a read-then-insert the services hope holds.
 */
export const timeEntries = pgTable("time_entries", {
  ...tenantColumns(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  note: text("note"),
}, (t) => [
  index("time_entries_org_user_started").on(t.organisationId, t.userId, t.startedAt),
  uniqueIndex("time_entries_one_running_per_user")
    .on(t.organisationId, t.userId)
    .where(sql`${t.endedAt} is null`),
]);

/** One "needs you today" line in a brief, with somewhere to go for it. */
export type OpsBriefHighlight = { label: string; detail?: string | undefined; link?: string | undefined };

/**
 * The daily Ops Brief the `ops-brief` agent writes at 07:00. One per
 * organisation per day: a re-run replaces the day's brief rather than adding
 * a second, so the history reads one entry per morning.
 */
export const opsBriefs = pgTable("ops_briefs", {
  ...tenantColumns(),
  briefDate: date("brief_date").notNull(),
  bodyMd: text("body_md").notNull(),
  highlights: jsonb("highlights").$type<OpsBriefHighlight[]>().default([]).notNull(),
  // No FK: `agent_runs` is deleted with its organisation anyway, and a brief
  // written by hand (or by a test) has no run behind it.
  agentRunId: uuid("agent_run_id"),
}, (t) => [uniqueIndex("ops_briefs_org_date").on(t.organisationId, t.briefDate)]);
