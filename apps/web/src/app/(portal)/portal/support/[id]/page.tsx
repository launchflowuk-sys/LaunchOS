import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { isVisibleToClient, MessageThread } from "@/components/portal/message-thread";
import { PortalForm } from "@/components/portal/portal-form";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { replyToPortalThread } from "../actions";

export const dynamic = "force-dynamic";

export default async function PortalTicketPage({ params }: PageProps<"/portal/support/[id]">) {
  const session = await requireClient();
  const { id } = await params;

  // A non-uuid would reach Postgres as a cast error rather than a miss, so it
  // is turned into the same 404 as any other id that is not this client's.
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) notFound();
  const ticketId = parsedId.data;

  const db = getDb();
  const [ticket] = await db
    .select({
      id: schema.tickets.id,
      subject: schema.tickets.subject,
      status: schema.tickets.status,
      severity: schema.tickets.severity,
      createdAt: schema.tickets.createdAt,
      conversationId: schema.tickets.conversationId,
    })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.organisationId, session.organisationId),
        // The scope that matters: another client's ticket id is a 404 here,
        // not a thread the wrong person gets to read.
        eq(schema.tickets.clientId, session.clientId),
      ),
    );
  if (!ticket) notFound();

  const messages = ticket.conversationId
    ? await db
        .select({
          id: schema.messages.id,
          direction: schema.messages.direction,
          authorKind: schema.messages.authorKind,
          body: schema.messages.body,
          createdAt: schema.messages.createdAt,
        })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.organisationId, session.organisationId),
            eq(schema.messages.conversationId, ticket.conversationId),
          ),
        )
        .orderBy(asc(schema.messages.createdAt))
    : [];

  const visible = messages.filter(isVisibleToClient);

  return (
    <>
      <PageHeader
        title={ticket.subject}
        description={`Raised ${formatDateTime(ticket.createdAt)}`}
        actions={
          <Link href="/portal/support" className="text-sm text-neutral-600 hover:underline">
            Back to support
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusBadge value={ticket.status} />
        <StatusBadge value={ticket.severity} />
      </div>

      <MessageThread messages={visible} />

      <div className="mt-6 max-w-2xl rounded-lg border border-neutral-200 bg-white p-5">
        <PortalForm
          action={replyToPortalThread}
          submitLabel="Send reply"
          ariaLabel="Reply to this request"
          success="Your reply has been added."
        >
          <input type="hidden" name="ticketId" value={ticket.id} />
          <div className="space-y-1.5">
            <label htmlFor="reply-body" className="block text-sm font-medium text-neutral-700">
              Add a reply
            </label>
            <textarea
              id="reply-body"
              name="body"
              required
              rows={4}
              maxLength={8000}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </div>
        </PortalForm>
      </div>
    </>
  );
}
