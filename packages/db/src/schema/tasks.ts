import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { taskKindEnum, taskPhaseEnum, taskTemplates } from "./packages.js";
import { sites } from "./sites.js";
import { actorKindEnum, tickets } from "./support.js";

export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "blocked", "review", "done", "cancelled"]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high", "urgent"]);

export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
export type TaskPriority = (typeof taskPriorityEnum.enumValues)[number];

/** One line of a task's checklist. Stored as jsonb so a task stays one row. */
export type ChecklistItem = { label: string; done: boolean };

export const tasks = pgTable("tasks", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  templateId: uuid("template_id").references(() => taskTemplates.id, { onDelete: "set null" }),
  phase: taskPhaseEnum("phase").notNull(),
  kind: taskKindEnum("kind").default("other").notNull(),
  title: text("title").notNull(),
  descriptionMd: text("description_md"),
  status: taskStatusEnum("status").default("todo").notNull(),
  priority: taskPriorityEnum("priority").default("medium").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: "set null" }),
  createdByKind: actorKindEnum("created_by_kind").default("system").notNull(),
  createdById: text("created_by_id"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  recurrenceKey: text("recurrence_key"),
  checklist: jsonb("checklist").$type<ChecklistItem[]>().default([]).notNull(),
  clientVisible: boolean("client_visible").default(true).notNull(),
}, (t) => [
  // Onboarding generation is idempotent by (client, template): re-running the
  // job after a package change tops up what is missing instead of duplicating.
  uniqueIndex("tasks_client_template_onboarding")
    .on(t.clientId, t.templateId)
    .where(sql`${t.templateId} is not null and ${t.phase} = 'onboarding'`),
  // Recurring generation is idempotent by (client, recurrence_key). NULLs are
  // distinct in Postgres, so non-recurring tasks are unaffected.
  uniqueIndex("tasks_client_recurrence_key").on(t.clientId, t.recurrenceKey),
  index("tasks_org_status_due").on(t.organisationId, t.status, t.dueAt),
  index("tasks_org_client_phase").on(t.organisationId, t.clientId, t.phase),
]);

export const taskComments = pgTable("task_comments", {
  ...tenantColumns(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  authorKind: actorKindEnum("author_kind").notNull(),
  authorId: text("author_id"),
  bodyMd: text("body_md").notNull(),
}, (t) => [index("task_comments_task_created").on(t.taskId, t.createdAt)]);
