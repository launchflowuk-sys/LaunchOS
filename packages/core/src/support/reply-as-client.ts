import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notify, notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { shortSubject } from "./subject.js";

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

    // Lock order: **tickets → conversations → tickets**, the same order
    // `replyToConversation` takes. A staff reply and a client reply can land on
    // one case in the same instant; if one took the conversation row first and
    // the other the ticket, Postgres would break the cycle by aborting one of
    // them with `40P01` and the loser would be told their message could not be
    // posted. Taking the ticket first here — before the `conversations` update
    // below — is what keeps the two paths in step, so this select must stay
    // above that update and must keep its `for("update")`.
    //
    // Locked, not merely read: under `READ COMMITTED` an unlocked read inside a
    // transaction is a snapshot, not a boundary. `setTicketClientVisibility`
    // committing between the read and the insert would let a client's words
    // land on a case that is now internal, reopen it, and notify its assignee
    // about work the client was never shown.
    const [ticket] = conversation.ticketId
      ? await tx
          .select()
          .from(schema.tickets)
          .where(and(eq(schema.tickets.id, conversation.ticketId), eq(schema.tickets.organisationId, organisationId)))
          .for("update")
      : [];

    // The boundary itself, not a repeat of the caller's. `replyAsClient` is
    // exported from `@launchos/core`, so a second portal surface, an agent
    // tool or a digest link that forgets the ticket lookup must still not be
    // able to put a client's words on an internal case — nor reopen one and
    // notify its assignee about work the client was never shown. Decided
    // against the locked row above, so it holds against a concurrent hide.
    // Nothing has been written at this point, so throwing here leaves no trace.
    if (ticket && !ticket.clientVisible) {
      throw new Error(`ticket ${ticket.id} is not visible to the client`);
    }

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
      ...(conversation.clientId ? { clientId: conversation.clientId } : {}),
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

  // Its own event, not `ticket.created`. The email path emits that for a
  // ticket made milliseconds earlier with no triage, no history and no
  // approvals; this id may already carry a triage result, an assignee and a
  // decided client reply, and `support-triage:<ticketId>` only dedupes jobs
  // still queued or active — so re-emitting `ticket.created` on a reopen would
  // pay for a second Claude run and park a duplicate approval on a case a
  // human had already closed out. The payload is not a new ticket, so it is
  // not that event. `reopened` is not part of it: the client replying is the
  // fact, and whether it revived the case is on the ticket row itself.
  if (result.ticket) {
    await emit({ name: "ticket.client_replied", organisationId, ticketId: result.ticket.id });
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
