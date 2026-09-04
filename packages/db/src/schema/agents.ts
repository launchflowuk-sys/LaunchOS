import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { actorKindEnum } from "./support.js";

export const agentTriggerEnum = pgEnum("agent_trigger", ["cron", "event", "manual", "resume"]);
export const agentRunStatusEnum = pgEnum("agent_run_status", ["running", "completed", "awaiting_approval", "failed"]);
export const agentStepKindEnum = pgEnum("agent_step_kind", ["llm", "tool_call", "tool_result", "approval_requested", "note"]);
export const approvalKindEnum = pgEnum("approval_kind", ["tool_call", "report_send", "message_send", "dns_change", "content_change"]);
export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved", "rejected"]);

export const agentEnablement = pgTable("agent_enablement", {
  ...tenantColumns(),
  agentKey: text("agent_key").notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
}, (t) => [uniqueIndex("agent_enablement_org_key").on(t.organisationId, t.agentKey)]);

export const agentRuns = pgTable("agent_runs", {
  ...tenantColumns(),
  agentKey: text("agent_key").notNull(),
  trigger: agentTriggerEnum("trigger").notNull(),
  status: agentRunStatusEnum("status").default("running").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().default({}).notNull(),
  summary: text("summary"),
  error: text("error"),
  tokensIn: integer("tokens_in").default(0).notNull(),
  tokensOut: integer("tokens_out").default(0).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const agentSteps = pgTable("agent_steps", {
  ...tenantColumns(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: agentStepKindEnum("kind").notNull(),
  toolName: text("tool_name"),
  input: jsonb("input").$type<unknown>().default({}).notNull(),
  output: jsonb("output").$type<unknown>().default({}).notNull(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
}, (t) => [uniqueIndex("agent_steps_run_seq").on(t.runId, t.seq)]);

export const approvals = pgTable("approvals", {
  ...tenantColumns(),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  stepId: uuid("step_id").references(() => agentSteps.id, { onDelete: "set null" }),
  kind: approvalKindEnum("kind").notNull(),
  title: text("title").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  status: approvalStatusEnum("status").default("pending").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
});

export const auditLog = pgTable("audit_log", {
  ...tenantColumns(),
  actorKind: actorKindEnum("actor_kind").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  before: jsonb("before").$type<unknown>(),
  after: jsonb("after").$type<unknown>(),
});
