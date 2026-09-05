import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { actorKindEnum } from "./support.js";

export const agentTriggerEnum = pgEnum("agent_trigger", ["cron", "event", "manual", "resume"]);
export const agentRunStatusEnum = pgEnum("agent_run_status", ["running", "completed", "awaiting_approval", "failed"]);
export const agentStepKindEnum = pgEnum("agent_step_kind", ["llm", "tool_call", "tool_result", "approval_requested", "note"]);
// `subscription_change` is the one kind a *client* raises: a portal user asking
// to cancel, downgrade or upgrade their plan. It has no run behind it and is
// decided like any other, then carried out by `applySubscriptionChangeDecision`.
export const approvalKindEnum = pgEnum("approval_kind", [
  "tool_call", "report_send", "message_send", "dns_change", "content_change", "subscription_change",
]);
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
}, (t) => [
  // At most one *pending* invoice send per invoice, enforced by the database
  // rather than by a read-then-insert in `requestInvoiceSendOnce`. Approving
  // two pending sends for the same invoice emails the client the same invoice
  // twice — the send claim is per-approval, so nothing downstream refuses the
  // second — and a check-then-insert loses that race by construction.
  //
  // Partial on purpose: once an approval is decided it stops occupying the
  // slot, so a resend or an overdue chase can file a fresh one. The predicate
  // is a constant expression over immutable operators, which is what Postgres
  // requires of an index predicate. Approvals that are not invoice sends carry
  // no `invoiceId` and are excluded outright by the `action` test.
  uniqueIndex("approvals_pending_invoice_send")
    .on(t.organisationId, sql`(${t.payload} ->> 'invoiceId')`)
    .where(sql`${t.status} = 'pending' and ${t.kind} = 'message_send' and ${t.payload} ->> 'action' = 'invoice_send'`),
  // At most one *pending* plan change request per client, for the same reason:
  // a portal form submitted twice must land one card in the queue, not two
  // that could be decided differently. `requestSubscriptionChange` reads first
  // and treats the index firing as "already pending".
  //
  // The predicate tests `payload->>'action'` rather than `kind` on purpose: the
  // migration that adds this index also adds the enum value, and Postgres
  // refuses to *use* a value added in the same transaction (`unsafe use of new
  // value`), while an enum-to-text cast is not immutable and so cannot sit in
  // an index predicate at all. `requestSubscriptionChange` always writes
  // `action` alongside `kind`, exactly as the invoice send does.
  uniqueIndex("approvals_pending_subscription_change")
    .on(t.organisationId, sql`(${t.payload} ->> 'clientId')`)
    .where(sql`${t.status} = 'pending' and ${t.payload} ->> 'action' = 'subscription_change'`),
]);

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
