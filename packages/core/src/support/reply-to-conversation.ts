import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const ReplyToConversationInput = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
  internal: z.boolean().default(false),
});
export type ReplyToConversationInput = z.input<typeof ReplyToConversationInput>;

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * Appends to a thread. An internal note stays inside LaunchOS: no email status,
 * no job. An outbound reply is written `queued` and emits `message.queued`; the
 * worker's `outbound.message` job is the only thing that talks to a mail server.
 */
export async function replyToConversation(db: Db, organisationId: string, input: ReplyToConversationInput) {
  const v = ReplyToConversationInput.parse(input);
  await assertOwned(db, organisationId, schema.conversations, v.conversationId);

  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, v.conversationId), eq(schema.conversations.organisationId, organisationId)));
  if (!conversation) throw new Error(`conversation ${v.conversationId} not found in organisation`);

  const outbound = !v.internal;
  const [identity] = await db
    .select()
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, conversation.clientId)));
  if (outbound && !conversation.participantEmail) throw new Error("conversation has no participant email to reply to");
  if (outbound && !identity) throw new Error("client has no support email identity; run ensureEmailIdentity");

  const [lastInbound] = await db
    .select({ externalId: schema.messages.externalId })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.direction, "inbound")))
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);

  const created = await db.transaction(async (tx) => {
    const [message] = await tx.insert(schema.messages).values({
      organisationId,
      conversationId: conversation.id,
      direction: outbound ? "outbound" : "internal",
      authorKind: v.actorKind,
      authorId: v.actorId ?? null,
      body: v.body,
      fromEmail: outbound ? identity!.address : null,
      toEmail: outbound ? conversation.participantEmail : null,
      subject: outbound ? replySubject(conversation.subject) : null,
      rawHeaders: outbound && lastInbound?.externalId ? { "in-reply-to": lastInbound.externalId } : {},
      status: outbound ? "queued" : null,
    }).returning();

    await tx.update(schema.conversations)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversation.id));

    // The first response on the linked ticket stops the SLA clock. `isNull`
    // makes this a no-op on every later reply without a read-then-write race.
    if (outbound && conversation.ticketId) {
      await tx.update(schema.tickets)
        .set({ firstResponseAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.tickets.id, conversation.ticketId),
          eq(schema.tickets.organisationId, organisationId),
          isNull(schema.tickets.firstResponseAt),
        ));
    }

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId,
      action: outbound ? "message.queued" : "message.note_added",
      targetType: "message", targetId: message!.id, after: message,
    });
    return message!;
  });

  if (outbound) await emit({ name: "message.queued", organisationId, messageId: created.id });
  return created;
}
