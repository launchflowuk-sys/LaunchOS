import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
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
      ),
    )
    .orderBy(asc(schema.messages.createdAt));

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

        <ThreadComposer
          action={sendThreadReply}
          conversationId={conversation.id}
          label="Reply"
          submitLabel="Send reply"
          placeholder="Your reply to the client"
          success="Reply queued"
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
