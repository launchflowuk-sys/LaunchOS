import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { isVisibleToClient, MessageThread } from "@/components/portal/message-thread";
import { PortalForm } from "@/components/portal/portal-form";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { replyToPortalThread } from "../actions";

export const dynamic = "force-dynamic";

/**
 * `messages.metadata.kind` on the courtesy notice queued by
 * `replyToConversation` — see `PORTAL_REPLY_NOTICE_KIND` in
 * packages/core/src/support/reply-to-conversation.ts. Copied rather than
 * imported: `@launchos/core` in a portal page would pull the whole domain
 * layer into this route.
 */
const REPLY_NOTICE_KIND = "portal_reply_notice";

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
        // And their own client's internal cases are a 404 too, so the list
        // filter cannot be walked around by typing the id.
        eq(schema.tickets.clientVisible, true),
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
          metadata: schema.messages.metadata,
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

  // `isVisibleToClient` stays a single clause on `direction` — widening it is
  // how the internal-note hole gets reopened. This is a second, narrower
  // filter for one thing: the courtesy email that tells a client a reply is
  // waiting is an `outbound` message like any other, and rendering it here
  // would put "sign in to read it" directly under the reply they are already
  // reading. It is the record of an email, not part of the conversation.
  const visible = messages.filter((m) => isVisibleToClient(m) && m.metadata["kind"] !== REPLY_NOTICE_KIND);

  return (
    <>
      <PageHeader
        title={ticket.subject}
        description={`Raised ${formatDateTime(ticket.createdAt)}`}
        category="support"
        actions={
          <Button asChild variant="secondary">
            <Link href="/portal/support">
              <ArrowLeft aria-hidden strokeWidth={1.75} />
              Back to support
            </Link>
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusBadge value={ticket.status} />
        <StatusBadge value={ticket.severity} />
      </div>

      <MessageThread messages={visible} />

      {/* The composer is the one action on this screen, so on a phone it stays
          on the glass at the bottom of the thread rather than below however
          many messages have accumulated. It bleeds to the edges to sit flush
          against the viewport, and becomes an ordinary card from `md`. */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t bg-card px-4 py-4 sm:-mx-6 sm:px-6 md:static md:mx-0 md:max-w-2xl md:rounded-xl md:border md:p-5">
        <PortalForm
          action={replyToPortalThread}
          submitLabel="Send reply"
          ariaLabel="Reply to this request"
          success="Your reply has been added."
        >
          <input type="hidden" name="ticketId" value={ticket.id} />
          <div className="space-y-1.5">
            <Label htmlFor="reply-body">Add a reply</Label>
            <Textarea id="reply-body" name="body" required rows={4} maxLength={8000} className="bg-card" />
          </div>
        </PortalForm>
      </div>
    </>
  );
}
