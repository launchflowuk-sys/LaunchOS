import type { InboundEmail } from "@launchos/channels";
import type { PaymentsWebhookEvent } from "@launchos/integrations";

export type DomainEvent =
  | { name: "incident.opened"; organisationId: string; incidentId: string }
  | { name: "ticket.created"; organisationId: string; ticketId: string }
  // A client answered a thread they already had. Distinct from `ticket.created`
  // because the ticket may already carry a triage result, an assignee and a
  // decided approval — see reply-as-client.ts.
  | { name: "ticket.client_replied"; organisationId: string; ticketId: string }
  | { name: "client.created"; organisationId: string; clientId: string }
  | { name: "site.created"; organisationId: string; siteId: string }
  | { name: "domain.created"; organisationId: string; domainId: string }
  | { name: "member.created"; organisationId: string; memberId: string }
  | { name: "task.created"; organisationId: string; taskId: string }
  | { name: "task.completed"; organisationId: string; taskId: string }
  | { name: "task.overdue"; organisationId: string; taskId: string }
  | { name: "email.received"; organisationId: string; inbound: InboundEmail }
  | { name: "message.queued"; organisationId: string; messageId: string }
  | { name: "ticket.escalated"; organisationId: string; ticketId: string }
  | {
      name: "approval.decided";
      organisationId: string;
      approvalId: string;
      runId: string;
      decision: "approved" | "rejected";
      note?: string;
    }
  | { name: "payments.webhook"; organisationId: string; providerEvent: PaymentsWebhookEvent }
  // An urgent notification for a user who has push subscriptions. The worker
  // turns it into a `push.send` job keyed `push:<notificationId>`; the job
  // reads the row back, so a notification whose transaction rolled back is a
  // no-op there, never a stray alert.
  | { name: "push.requested"; organisationId: string; notificationId: string; userId: string }
  // A new enquiry with an email address. The worker starts the Lead Qualifier
  // on it; the acknowledgement email is already queued by `createLead`.
  | { name: "lead.created"; organisationId: string; leadId: string };

export type EnqueueFn = (event: DomainEvent) => Promise<void>;
let enqueue: EnqueueFn = async () => {}; // no-op until the worker or web sets one

export function setEnqueue(fn: EnqueueFn) { enqueue = fn; }
export async function emit(event: DomainEvent) { await enqueue(event); }
