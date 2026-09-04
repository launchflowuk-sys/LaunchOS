import { listMembers } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { MessageThread } from "@/components/message-thread";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ThreadComposer } from "@/components/thread-composer";
import { TriagePanel } from "@/components/triage-panel";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { isClosed } from "../filters";
import {
  addCaseNote,
  assignTicketAction,
  escalateTicketAction,
  runTriageNow,
  setTicketStatus,
} from "./actions";
import { hasTriageInFlight } from "./triage-status";

export const dynamic = "force-dynamic";

const CARD = "rounded-lg border border-neutral-200 bg-white p-4";
const HEADING = "mb-2 text-sm font-semibold text-neutral-900";
const CONTROL = "h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";

// Read in the server component and handed down as a plain array: importing
// @launchos/db from a client component would pull the postgres driver into the
// browser bundle.
const STATUSES = schema.ticketStatusEnum.enumValues;

export default async function CaseDetailPage({ params }: PageProps<"/cases/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;
  // A malformed id is a 404, not a 22P02 from Postgres rendered as a 500.
  uuidOr404(id);

  const [ticket] = await getDb()
    .select({
      id: schema.tickets.id,
      subject: schema.tickets.subject,
      category: schema.tickets.category,
      severity: schema.tickets.severity,
      status: schema.tickets.status,
      source: schema.tickets.source,
      escalated: schema.tickets.escalated,
      escalationReason: schema.tickets.escalationReason,
      assignedUserId: schema.tickets.assignedUserId,
      conversationId: schema.tickets.conversationId,
      slaDueAt: schema.tickets.slaDueAt,
      firstResponseAt: schema.tickets.firstResponseAt,
      createdAt: schema.tickets.createdAt,
      triage: schema.tickets.triage,
      clientId: schema.tickets.clientId,
      clientName: schema.clients.name,
    })
    .from(schema.tickets)
    .innerJoin(schema.clients, eq(schema.tickets.clientId, schema.clients.id))
    // Scoped by organisation, so another tenant's ticket id is a 404 here.
    .where(and(eq(schema.tickets.id, id), eq(schema.tickets.organisationId, session.organisationId)));
  if (!ticket) notFound();

  const [messages, events, tasks, members, triageInFlight] = await Promise.all([
    ticket.conversationId
      ? getDb()
          .select({
            id: schema.messages.id,
            direction: schema.messages.direction,
            authorKind: schema.messages.authorKind,
            authorId: schema.messages.authorId,
            body: schema.messages.body,
            subject: schema.messages.subject,
            status: schema.messages.status,
            createdAt: schema.messages.createdAt,
            attachments: schema.messages.attachments,
          })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, ticket.conversationId),
              eq(schema.messages.organisationId, session.organisationId),
            ),
          )
          .orderBy(asc(schema.messages.createdAt))
      : [],
    getDb()
      .select()
      .from(schema.ticketEvents)
      .where(
        and(
          eq(schema.ticketEvents.ticketId, ticket.id),
          eq(schema.ticketEvents.organisationId, session.organisationId),
        ),
      )
      .orderBy(desc(schema.ticketEvents.createdAt)),
    getDb()
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        dueAt: schema.tasks.dueAt,
      })
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.ticketId, ticket.id), eq(schema.tasks.organisationId, session.organisationId)),
      )
      .orderBy(asc(schema.tasks.createdAt)),
    listMembers(getDb(), session.organisationId),
    hasTriageInFlight(session.organisationId, ticket.id),
  ]);

  const breached = !!ticket.slaDueAt && ticket.slaDueAt < new Date() && !isClosed(ticket.status);

  return (
    <>
      <PageHeader
        title={ticket.subject}
        description={`${ticket.clientName} · ${ticket.source} · opened ${formatDateTime(ticket.createdAt)}`}
        actions={
          <div role="group" aria-label="Case status" className="flex flex-wrap items-center gap-2">
            <StatusBadge value={ticket.severity} />
            <StatusBadge value={ticket.status} />
            {ticket.escalated ? <StatusBadge value="escalated" tone="danger" /> : null}
            <StatusBadge
              value={`SLA ${formatDateTime(ticket.slaDueAt)}`}
              tone={breached ? "danger" : "neutral"}
            />
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className={CARD}>
            <h2 className={HEADING}>Conversation</h2>
            <MessageThread messages={messages} />
          </section>

          {/* The composer posts no conversationId: `addCaseNote` reads the
              thread off the org-scoped ticket, so the two cannot disagree. */}
          {ticket.conversationId ? (
            <ThreadComposer
              action={addCaseNote}
              hidden={{ ticketId: ticket.id }}
              label="Internal note"
              submitLabel="Add internal note"
              placeholder="Only the team sees this"
              success="Note added"
            />
          ) : null}

          <section className={CARD}>
            <h2 className={HEADING}>History</h2>
            {events.length === 0 ? (
              <p className="text-sm text-neutral-400">Nothing recorded yet.</p>
            ) : (
              <ul className="space-y-1.5 text-sm text-neutral-700">
                {events.map((event) => (
                  <li key={event.id} className="flex flex-wrap gap-2">
                    <span className="font-medium">{event.kind.replaceAll("_", " ")}</span>
                    <span className="text-neutral-500">by {event.actorKind}</span>
                    <span className="ml-auto text-xs text-neutral-400">{formatDateTime(event.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <section className={CARD}>
            <h2 className={HEADING}>Triage</h2>
            <TriagePanel triage={ticket.triage} />
            <ActionForm action={runTriageNow} ariaLabel="Run triage" success="Triage queued" className="mt-3">
              <input type="hidden" name="ticketId" value={ticket.id} />
              {/* Each press is a billed Claude run; the action refuses a second
                  one too, so a direct POST is bounded by the same rule. */}
              <Button type="submit" variant="outline" disabled={triageInFlight}>
                {triageInFlight ? "Triage running…" : "Run triage now"}
              </Button>
            </ActionForm>
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Status</h2>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((value) => (
                <ActionForm key={value} action={setTicketStatus} ariaLabel={`Set status ${value}`} success="Status updated">
                  <input type="hidden" name="ticketId" value={ticket.id} />
                  <input type="hidden" name="status" value={value} />
                  <Button type="submit" variant={value === ticket.status ? "default" : "outline"} size="sm">
                    {value.replaceAll("_", " ")}
                  </Button>
                </ActionForm>
              ))}
            </div>
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Assignee</h2>
            <ActionForm action={assignTicketAction} ariaLabel="Assign case" success="Case assigned" className="space-y-2">
              <input type="hidden" name="ticketId" value={ticket.id} />
              <select
                name="assignedUserId"
                aria-label="Assign to"
                defaultValue={ticket.assignedUserId ?? ""}
                className={CONTROL}
              >
                <option value="">Least loaded staff member</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName ?? m.name}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="outline">
                Assign
              </Button>
            </ActionForm>
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Escalate</h2>
            {ticket.escalationReason ? (
              <p className="mb-2 text-sm text-neutral-600">{ticket.escalationReason}</p>
            ) : null}
            <ActionForm
              action={escalateTicketAction}
              ariaLabel="Escalate case"
              success="Case escalated"
              resetOnSuccess
              className="space-y-2"
            >
              <input type="hidden" name="ticketId" value={ticket.id} />
              <textarea
                name="reason"
                rows={2}
                required
                maxLength={1000}
                aria-label="Escalation reason"
                placeholder="Why this needs Shoji"
                className="w-full rounded-md border border-neutral-300 p-2 text-sm"
              />
              <Button type="submit" variant="destructive">
                Escalate
              </Button>
            </ActionForm>
          </section>

          <section className={CARD}>
            <h2 className={HEADING}>Linked tasks</h2>
            {tasks.length === 0 ? (
              <p className="text-sm text-neutral-400">No tasks linked to this case.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {tasks.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/tasks/${task.id}`} className="text-neutral-800 underline underline-offset-2">
                      {task.title}
                    </Link>
                    <StatusBadge value={task.status} />
                    <span className="ml-auto text-xs text-neutral-400">{formatDateTime(task.dueAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {ticket.conversationId ? (
            <p className="text-xs text-neutral-500">
              <Link href={`/inbox/${ticket.conversationId}`} className="underline underline-offset-2">
                Reply to the client in the Inbox
              </Link>
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
