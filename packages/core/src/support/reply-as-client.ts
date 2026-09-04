import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notify, notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const ReplyAsClientInput = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1),
  /** The Better Auth user id of the portal user who wrote it. */
  actorId: z.string().min(1),
  /**
   * The client the portal session is scoped to. Supplied so a conversation id
   * that belongs to another client of the same organisation is rejected here
   * as well as at the call site.
   */
  clientId: z.string().uuid().optional(),
});
export type ReplyAsClientInput = z.input<typeof ReplyAsClientInput>;

/**
 * `activity_events.title` and `notifications.title` are both capped at 200, and
 * a subject is allowed 200 of its own — so a long one would throw at the Zod
 * boundary and roll back the whole reply. Trim rather than lose the message.
 */
const TITLE_SUBJECT_LIMIT = 120;
function shortSubject(subject: string): string {
  return subject.length <= TITLE_SUBJECT_LIMIT ? subject : `${subject.slice(0, TITLE_SUBJECT_LIMIT - 1)}…`;
}

/** A reply lands on a live thread; these two mean the case had been put to bed. */
const CLOSED_TICKET_STATUSES: readonly string[] = ["resolved", "closed"];
/** Every status a client reply pulls back to `open`. */
const REOPENED_FROM: readonly string[] = [...CLOSED_TICKET_STATUSES, "waiting_client"];

/**
 * A client answering their own thread from the portal.
 *
 * This is the same event as a client replying by email, so it is written the
 * same way `ingestInboundEmail` writes one: `direction: "inbound"` with
 * `author_kind: "client"`, the conversation forced back to `open`, a resolved,
 * closed or waiting_client ticket pulled back to `open` with a `ticket_events`
 * row behind it, a client-timeline entry, and a notification to whoever owns
 * the case. `direction` is what decides it — the Inbox's "needs reply" badge is
 * `lastDirection === "inbound"`, so an `internal` row here would be a message
 * nobody is ever told about.
 *
 * `replyToConversation` stays the staff path: `outbound` mail and `internal`
 * notes. Nothing here ever leaves LaunchOS as email — a client does not need
 * their own words posted back to them.
 */
export async function replyAsClient(db: Db, organisationId: string, input: ReplyAsClientInput) {
  const v = ReplyAsClientInput.parse(input);
  await assertOwned(db, organisationId, schema.conversations, v.conversationId);

  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, v.conversationId), eq(schema.conversations.organisationId, organisationId)));
  if (!conversation) throw new Error(`conversation ${v.conversationId} not found in organisation`);
  if (v.clientId && conversation.clientId !== v.clientId) {
    throw new Error(`conversation ${conversation.id} belongs to another client`);
  }

  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();

    const [message] = await tx
      .insert(schema.messages)
      .values({
        organisationId,
        conversationId: conversation.id,
        direction: "inbound",
        authorKind: "client",
        authorId: v.actorId,
        body: v.body,
        // queued/sent/failed/received describe email; a portal reply is neither.
        status: null,
      })
      .returning();

    await tx
      .update(schema.conversations)
      .set({ lastMessageAt: now, status: "open", updatedAt: now })
      .where(eq(schema.conversations.id, conversation.id));

    const [ticket] = conversation.ticketId
      ? await tx
          .select()
          .from(schema.tickets)
          .where(and(eq(schema.tickets.id, conversation.ticketId), eq(schema.tickets.organisationId, organisationId)))
      : [];

    let reopened = false;
    if (ticket && REOPENED_FROM.includes(ticket.status)) {
      reopened = true;
      await tx
        .update(schema.tickets)
        .set({ status: "open", resolvedAt: null, updatedAt: now })
        .where(and(eq(schema.tickets.id, ticket.id), eq(schema.tickets.organisationId, organisationId)));
      await tx.insert(schema.ticketEvents).values({
        organisationId,
        ticketId: ticket.id,
        kind: "status_changed",
        actorKind: "client",
        actorId: v.actorId,
        data: { from: ticket.status, to: "open", reason: "client replied in the portal" },
      });
    }

    await recordActivity(tx, organisationId, {
      clientId: conversation.clientId,
      actorKind: "client",
      actorId: v.actorId,
      kind: "support.portal_reply",
      title: `Reply received: ${shortSubject(conversation.subject)}`,
      link: ticket ? `/cases/${ticket.id}` : `/inbox/${conversation.id}`,
    });

    await recordAudit(tx, organisationId, {
      actorKind: "client",
      actorId: v.actorId,
      action: "message.received",
      targetType: "message",
      targetId: message!.id,
      after: message,
    });

    return { message: message!, ticket, reopened };
  });

  // After commit: nobody is told about an id the transaction rolled back.
  await notifyCaseOwner(db, organisationId, conversation.subject, result.ticket, conversation.id);

  // A ticket that had been resolved or closed is, to the agency, a new piece of
  // work — which is exactly when the email path opens a ticket and emits this.
  // Support Triage reruns on the revived case rather than nobody noticing it.
  if (result.reopened && result.ticket && CLOSED_TICKET_STATUSES.includes(result.ticket.status)) {
    await emit({ name: "ticket.created", organisationId, ticketId: result.ticket.id });
  }

  return result;
}

/**
 * The assignee if the case has one and they are still an active member,
 * otherwise whoever runs the organisation. A reply nobody is told about is the
 * failure this whole function exists to prevent, so the fallback matters.
 */
async function notifyCaseOwner(
  db: Db,
  organisationId: string,
  subject: string,
  ticket: typeof schema.tickets.$inferSelect | undefined,
  conversationId: string,
) {
  const payload = {
    kind: "support.portal_reply",
    title: `Client replied: ${shortSubject(subject)}`,
    link: ticket ? `/cases/${ticket.id}` : `/inbox/${conversationId}`,
  };

  if (ticket?.assignedUserId) {
    const [member] = await db
      .select({ id: schema.organisationMembers.id })
      .from(schema.organisationMembers)
      .where(
        and(
          eq(schema.organisationMembers.organisationId, organisationId),
          eq(schema.organisationMembers.userId, ticket.assignedUserId),
          eq(schema.organisationMembers.status, "active"),
        ),
      )
      .limit(1);
    if (member) return notify(db, organisationId, { ...payload, userId: ticket.assignedUserId });
  }
  return notifyOwner(db, organisationId, payload);
}
