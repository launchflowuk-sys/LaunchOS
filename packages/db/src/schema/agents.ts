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
// `content_publish` is a content item asking to go out: approving it is what
// lets the publish job send it, carried out by `applyContentPublishDecision`.
// `lead_reply` is the Lead Qualifier's drafted first reply to an enquiry —
// run-less, decided on /approvals and carried out by `applyLeadReplyDecision`.
// `proposal_send` is the Proposal Drafter's finished draft asking to go to the
// client — run-less too, decided on /approvals, and carried out by the worker,
// because sending renders a PDF and only `apps/worker` has a browser.
// `client_review` is the second kind a *client* decides, and the only one that
// is not a gate: Shoji invites them to look at a design, they approve or
// comment, and **nothing waits on them either way** — see
// `packages/core/src/projects/client-review.ts`.
// `project_update` is the Project Reporter's drafted Friday note to a client —
// run-less, decided on /approvals, and carried out by
// `applyProjectUpdateDecision`, which queues the email.
// `case_study_publish` is the one approval on this list the *kernel* raises:
// the Case Study Writer's `case_study_publish` tool is `requires_approval`, so
// the run parks and approving it resumes the run and executes the tool. It
// therefore carries a `run_id` and the kernel's own payload shape, not an
// `action` — which is why it has no pending index below.
export const approvalKindEnum = pgEnum("approval_kind", [
  "tool_call", "report_send", "message_send", "dns_change", "content_change", "subscription_change", "content_publish",
  "content_report_send", "lead_reply", "proposal_send", "client_review", "project_update", "case_study_publish",
]);
/** What a card is called on /approvals. A tool may name its own — see `ToolDefinition.approvalKind`. */
export type ApprovalKind = (typeof approvalKindEnum.enumValues)[number];

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
  // At most one *pending* publish request per content item, for the same
  // reason and in the same shape: `requestContentApproval` writes
  // `payload.action = 'content_publish'` alongside the enum value, and the
  // predicate tests the payload so the index and the enum value can land in
  // one migration.
  uniqueIndex("approvals_pending_content_publish")
    .on(t.organisationId, sql`(${t.payload} ->> 'itemId')`)
    .where(sql`${t.status} = 'pending' and ${t.payload} ->> 'action' = 'content_publish'`),
  // At most one *pending* send per content report — `requestContentReportSend`
  // writes `payload.action = 'content_report_send'` beside the enum value, for
  // the same one-migration reason as the two above.
  uniqueIndex("approvals_pending_content_report_send")
    .on(t.organisationId, sql`(${t.payload} ->> 'reportId')`)
    .where(sql`${t.status} = 'pending' and ${t.payload} ->> 'action' = 'content_report_send'`),
  // At most one *pending* drafted reply per lead — a re-run of the qualifier
  // must not stack two cards for one enquiry. `requestLeadReply` writes
  // `payload.action = 'lead_reply'` beside the enum value, same reasoning.
  uniqueIndex("approvals_pending_lead_reply")
    .on(t.organisationId, sql`(${t.payload} ->> 'leadId')`)
    .where(sql`${t.status} = 'pending' and ${t.payload} ->> 'action' = 'lead_reply'`),
  // At most one *pending* send request per proposal. A client must never be
  // sent the same reference twice because the drafter was re-run while the
  // first card was still waiting, and a proposal is frozen once sent, so the
  // second send would be refused anyway — better it never reaches the queue.
  // `requestProposalApproval` writes `payload.action = 'proposal_send'` beside
  // the enum value, same one-migration reasoning as the four above.
  uniqueIndex("approvals_pending_proposal_send")
    .on(t.organisationId, sql`(${t.payload} ->> 'proposalId')`)
    .where(sql`${t.status} = 'pending' and ${t.payload} ->> 'action' = 'proposal_send'`),
  // At most one *open* review per thing being reviewed —
  // `payload.targetRef` is `milestone:<id>` or `project:<id>`.
  //
  // The other five indexes on this table stop a duplicate *outward action*: a
  // second email, a second quote, a second post. This one is not about that; a
  // client review sends nothing. It is about the client's page. A review is an
  // invitation to look at one thing, and because it never blocks anything, a
  // second invitation about the same thing buys no time — it only makes a
  // portal that was meant to read as "here is where we are" read as a queue of
  // work the client owes us. If two things need looking at, they are two
  // milestones. Same payload-not-enum predicate as the four above, for the
  // same one-migration reason.
  //
  // `deleted_at is null` is in the predicate here and not in the five above,
  // and the difference is real: a review Shoji withdraws because it no longer
  // needs answering is soft-deleted, and the slot has to come free so he can
  // ask about the same milestone again. Nothing withdraws a proposal send or a
  // content publish that way, so those five have never needed it.
  uniqueIndex("approvals_pending_client_review")
    .on(t.organisationId, sql`(${t.payload} ->> 'targetRef')`)
    .where(sql`${t.status} = 'pending' and ${t.deletedAt} is null and ${t.payload} ->> 'action' = 'client_review'`),
  // At most one *pending* weekly update per project. The Friday cron is the
  // reason: a project whose last draft is still waiting for Shoji does not
  // want a second week's draft stacked behind it, because approving them out
  // of order would send the client last week's news after this week's.
  uniqueIndex("approvals_pending_project_update")
    .on(t.organisationId, sql`(${t.payload} ->> 'projectId')`)
    .where(sql`${t.status} = 'pending' and ${t.payload} ->> 'action' = 'project_update'`),
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
