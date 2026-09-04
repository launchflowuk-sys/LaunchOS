import { isCourtesyNotice } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, asc, eq, not } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MessageThread } from "@/components/message-thread";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ThreadComposer } from "@/components/thread-composer";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { addInternalNote, sendThreadReply } from "./actions";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: PageProps<"/inbox/[conversationId]">) {
  const session = await requireAdmin();
  const { conversationId } = await params;
  // A malformed id is a 404, not a 22P02 from Postgres rendered as a 500.
  uuidOr404(conversationId);

  const [conversation] = await getDb()
    .select({
      id: schema.conversations.id,
      subject: schema.conversations.subject,
      status: schema.conversations.status,
      channel: schema.conversations.channel,
      participantEmail: schema.conversations.participantEmail,
      ticketId: schema.conversations.ticketId,
      clientName: schema.clients.name,
    })
    .from(schema.conversations)
    .innerJoin(schema.clients, eq(schema.conversations.clientId, schema.clients.id))
    // Scoped by organisation, so another tenant's conversation id is a 404 here.
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.organisationId, session.organisationId),
      ),
    );
  if (!conversation) notFound();

  const messages = await getDb()
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
        eq(schema.messages.conversationId, conversation.id),
        eq(schema.messages.organisationId, session.organisationId),
        // The courtesy nudge is addressed to the client and would otherwise be
        // the newest row under every portal reply, so the thread would end
        // "sign in to the portal to read it" rather than with the answer.
        not(isCourtesyNotice()),
      ),
    )
    .orderBy(asc(schema.messages.createdAt));

  // The same line core draws: an email thread is delivered by mail (and throws
  // if it has no address), anything else is delivered by the portal.
  const emailThread = conversation.channel === "email";

  return (
    <>
      <PageHeader
        title={conversation.subject}
        description={`${conversation.clientName} · ${conversation.channel} · ${conversation.participantEmail ?? "no email address"}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge value={conversation.status} />
            {conversation.ticketId ? (
              <Link
                href={`/cases/${conversation.ticketId}`}
                className="text-sm text-neutral-700 underline underline-offset-2"
              >
                Open case
              </Link>
            ) : null}
          </div>
        }
      />

      <div className="space-y-4">
        <MessageThread messages={messages} />

        {/* Labelled by how it is actually delivered. The same action serves
            both: `replyToConversation` emails a thread that has an address and
            posts one that has not straight into the client's portal. */}
        <ThreadComposer
          action={sendThreadReply}
          conversationId={conversation.id}
          label={emailThread ? "Reply by email" : "Reply in the portal"}
          submitLabel="Send reply"
          placeholder={
            emailThread
              ? conversation.participantEmail
                ? `Emailed to ${conversation.participantEmail}`
                : "This thread has no email address — answer it on the case instead"
              : "Appears in the client's portal straight away"
          }
          success={emailThread ? "Reply queued" : "Reply posted"}
        />

        <ThreadComposer
          action={addInternalNote}
          conversationId={conversation.id}
          label="Internal note"
          submitLabel="Add internal note"
          placeholder="Only the team sees this"
          success="Note added"
        />
      </div>
    </>
  );
}
