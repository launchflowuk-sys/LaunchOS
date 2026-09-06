import { LEAD_QUALIFIER_KEY } from "@launchos/agents";
import { ensureEmailIdentity, getLead, type DomainEvent } from "@launchos/core";
import type { Db } from "@launchos/db";
import type PgBoss from "pg-boss";
import { QUEUE } from "../boss.js";
import { incidentPayload, ticketPayload, type AgentRunJob } from "./agent-run.js";
import type { AgentResumeJob } from "./agent-resume.js";
import type { InboundMessageJob } from "./inbound-message.js";
import type { OutboundMessageJob } from "./outbound-message.js";
import type { GenerateOnboardingJob } from "./task-generation.js";
import type { PaymentsWebhookJob } from "./payments-webhook.js";
import type { PushSendJob } from "./push-send.js";

/** The lead sources the qualifier answers. `manual`, `signup` and `booking` are deliberately absent — see the branch below. */
export const QUALIFIED_LEAD_SOURCES: readonly string[] = ["website", "funnel", "api", "referral"];

/** The only pg-boss surface this needs — narrow enough to fake in tests. */
export type BossSender = Pick<PgBoss, "send">;

export interface DispatchEventDeps { db: Db; boss: BossSender; }

/**
 * The single routing table from a domain event to a pg-boss job. Both entry
 * points funnel through here: events emitted inside the worker process, and
 * events the web process sends onto the `domain.event` queue (the web app
 * never picks a queue name itself). This is the only place `client.created`
 * maps to `tasks.generate-onboarding`, so a future consumer added to that
 * branch (e.g. Plan 4's `ensureEmailIdentity`) fires for every client
 * regardless of whether it was created from the web app or the worker.
 */
export async function dispatchEvent(deps: DispatchEventDeps, event: DomainEvent): Promise<void> {
  const { db, boss } = deps;
  if (event.name === "incident.opened") {
    const payload = await incidentPayload(db, event.organisationId, event.incidentId);
    const job: AgentRunJob = { agentKey: "hosting-guard-dog", organisationId: event.organisationId, trigger: "event", payload };
    await boss.send(QUEUE.agentRun, job, { singletonKey: `guard-dog:${event.incidentId}` });
    return;
  }
  if (event.name === "client.created") {
    const job: GenerateOnboardingJob = { organisationId: event.organisationId, clientId: event.clientId };
    await boss.send(QUEUE.tasksGenerateOnboarding, job, { singletonKey: `onboarding:${event.clientId}` });
    // Every client needs a routable support address, regardless of whether
    // onboarding tasks were skipped (e.g. re-created client, existing identity).
    await ensureEmailIdentity(db, event.organisationId, { clientId: event.clientId });
    return;
  }
  if (event.name === "ticket.created") {
    const payload = await ticketPayload(db, event.organisationId, event.ticketId);
    const job: AgentRunJob = { agentKey: "support-triage", organisationId: event.organisationId, trigger: "event", payload };
    await boss.send(QUEUE.agentRun, job, { singletonKey: `support-triage:${event.ticketId}` });
    return;
  }
  if (event.name === "ticket.client_replied") {
    // Routed nowhere on purpose. A client reply already reopens the case,
    // records the activity and notifies the assignee inside `replyAsClient`;
    // what it must NOT do is start a second Support Triage run over a ticket
    // that may already hold a triage result and a decided approval, which is
    // exactly what routing it to `agent.run` would do. Named and handled here
    // so the next person sees the decision rather than the fall-through log.
    return;
  }
  if (event.name === "email.received") {
    const job: InboundMessageJob = { organisationId: event.organisationId, inbound: event.inbound };
    // The provider's Message-ID is the natural dedupe key for a redelivery.
    await boss.send(QUEUE.inboundMessage, job, { singletonKey: `inbound:${event.inbound.messageId}` });
    return;
  }
  if (event.name === "message.queued") {
    const job: OutboundMessageJob = { organisationId: event.organisationId, messageId: event.messageId };
    await boss.send(QUEUE.outboundMessage, job, { singletonKey: `outbound:${event.messageId}` });
    return;
  }
  if (event.name === "approval.decided") {
    const job: AgentResumeJob = {
      organisationId: event.organisationId, runId: event.runId, approvalId: event.approvalId,
      decision: event.decision,
      // `exactOptionalPropertyTypes` treats an explicit `undefined` value as
      // different from an absent key, so only set `note` when the event carried one.
      ...(event.note !== undefined && { note: event.note }),
    };
    await boss.send(QUEUE.agentResume, job, { singletonKey: `resume:${event.approvalId}` });
    return;
  }
  if (event.name === "payments.webhook") {
    const job: PaymentsWebhookJob = { organisationId: event.organisationId, providerEvent: event.providerEvent };
    // The Stripe route enqueues this job directly (apps/web/src/lib/queue.ts's
    // `sendJob`) rather than through `emit`, so this branch only matters if
    // something inside the worker process ever raises the event itself.
    // A plain key, matching the route: it collapses a burst of identical
    // deliveries while the job is queued. A `singletonSeconds` window would
    // also cover `failed` and so block the redelivery that is the only
    // recovery path a failed sync has — see packages/core/src/queue/queues.ts.
    await boss.send(QUEUE.paymentsWebhook, job, { singletonKey: `stripe:${event.providerEvent.id}` });
    return;
  }
  if (event.name === "lead.created") {
    // The Lead Qualifier drafts a first reply for an enquiry that arrived on
    // its own — the website form, a funnel, the public API — and has an
    // address to answer. A `manual` lead is Shoji's own note; a `signup` lead
    // is mid-Checkout and gets the welcome email instead; a `booking` lead
    // just booked a call and got the confirmation. None of those wants a
    // "thanks for your enquiry" draft on top.
    const lead = await getLead(db, event.organisationId, event.leadId);
    if (!lead || !lead.email || !QUALIFIED_LEAD_SOURCES.includes(lead.source)) {
      console.info({ leadId: event.leadId, source: lead?.source ?? null, hasEmail: !!lead?.email }, "lead.created: qualifier not started");
      return;
    }
    const job: AgentRunJob = { agentKey: LEAD_QUALIFIER_KEY, organisationId: event.organisationId, trigger: "event", payload: { leadId: lead.id } };
    await boss.send(QUEUE.agentRun, job, { singletonKey: `lead-qualifier:${lead.id}` });
    return;
  }
  if (event.name === "push.requested") {
    // `notify()` emits this for every urgent notification whose user has a
    // subscribed device. One job per notification; the job fans out to the
    // user's devices itself, and the key collapses a re-emit from a retried
    // transaction while the first job is still queued.
    const job: PushSendJob = { organisationId: event.organisationId, notificationId: event.notificationId, userId: event.userId };
    await boss.send(QUEUE.pushSend, job, { singletonKey: `push:${event.notificationId}` });
    return;
  }
  // site.created / domain.created / member.created / task.created /
  // task.completed / task.overdue have no consumer yet; logged and ignored
  // on purpose.
  console.info({ event: event.name }, "domain event with no consumer");
}
