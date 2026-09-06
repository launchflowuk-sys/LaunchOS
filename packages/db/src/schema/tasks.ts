import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { taskKindEnum, taskPhaseEnum, taskTemplates } from "./packages.js";
import { projectPhases, projects } from "./projects.js";
import { sites } from "./sites.js";
import { actorKindEnum, tickets } from "./support.js";

export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "blocked", "review", "done", "cancelled"]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high", "urgent"]);

export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
export type TaskPriority = (typeof taskPriorityEnum.enumValues)[number];

/** One line of a task's checklist. Stored as jsonb so a task stays one row. */
export type ChecklistItem = { label: string; done: boolean };

/** One proof line, ticked by a named person at a known time. */
export type TaskEvidenceChecklistItem = { item: string; done: boolean; doneBy?: string | undefined; doneAt?: string | undefined };

/** A screenshot (or any file) attached as proof — stored under STORAGE_DIR like an inbound attachment. */
export type TaskEvidenceAttachment = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  uploadedBy?: string | undefined;
  uploadedAt: string;
};

/**
 * The proof of work on a task: links to what was delivered, screenshots, and
 * the ticked proof checklist copied from the template. `updateTaskStatus`
 * refuses `done` while the template's `evidence.required` is unmet.
 */
export type TaskEvidence = {
  links: string[];
  attachments: TaskEvidenceAttachment[];
  checklist: TaskEvidenceChecklistItem[];
};

export const TASK_EVIDENCE_DEFAULT: TaskEvidence = { links: [], attachments: [], checklist: [] };

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
  evidence: jsonb("evidence").$type<TaskEvidence>().default(TASK_EVIDENCE_DEFAULT).notNull(),
  clientVisible: boolean("client_visible").default(true).notNull(),
  /**
   * The build this task belongs to, and which step of it — both nullable, and
   * both added rather than replacing anything. Most tasks have no project:
   * onboarding, recurring care and anything raised from a support case are
   * work for a client, not work on a build. A task that does belong to one
   * shows on the project's spine and is counted by `getProject`.
   */
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  phaseId: uuid("phase_id").references(() => projectPhases.id, { onDelete: "set null" }),
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
  // The project page counts its tasks by phase in one grouped read; without
  // this it is a sequential scan every time a client opens their progress page.
  index("tasks_project_phase").on(t.projectId, t.phaseId),
]);

export const taskComments = pgTable("task_comments", {
  ...tenantColumns(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  authorKind: actorKindEnum("author_kind").notNull(),
  authorId: text("author_id"),
  bodyMd: text("body_md").notNull(),
}, (t) => [index("task_comments_task_created").on(t.taskId, t.createdAt)]);
