import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { replySubject, shortSubject } from "./subject.js";

export const ReplyToConversationInput = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
  internal: z.boolean().default(false),
  /**
   * Absolute base URL of the app, used only to put a link in the courtesy
   * email that tells a client a portal reply is waiting. Absent, the notice
   * still goes out — it just says "sign in" without saying where.
   */
  portalUrl: z.string().url().optional(),
});
export type ReplyToConversationInput = z.input<typeof ReplyToConversationInput>;

/**
 * The statuses a reply to the client moves on: we have answered, so the ball
 * is in their court. `triaged` is deliberately not here — a triaged case is
 * still ours until somebody works it.
 */
const AWAITING_CLIENT_FROM: readonly string[] = ["open", "in_progress"];

/** What the courtesy email says. Never the reply itself — that stays behind the login. */
const NOTICE_BODY = "LaunchFlow has replied to your support case. Sign in to the portal to read it.";

/**
 * `messages.metadata.kind` on the courtesy notice. The portal thread filters on
 * it — `(portal)/portal/support/[id]/page.tsx` carries the same string, because
 * importing `@launchos/core` into a portal page would drag the whole domain
 * layer into that route — so keep the two in step.
 */
export const PORTAL_REPLY_NOTICE_KIND = "portal_reply_notice";

/**
 * The address a courtesy notice goes to: the client record's own email, else
 * the primary contact's. Null is a normal answer — plenty of clients are
 * managed entirely through the portal — and never a reason to fail a reply.
 */
async function noticeAddress(db: Db, organisationId: string, clientId: string): Promise<string | null> {
  const [client] = await db
    .select({ email: schema.clients.email })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  if (client?.email) return client.email;

  const [contact] = await db
    .select({ email: schema.clientContacts.email })
    .from(schema.clientContacts)
    .where(and(
      eq(schema.clientContacts.clientId, clientId),
      eq(schema.clientContacts.organisationId, organisationId),
      eq(schema.clientContacts.isPrimary, true),
      isNotNull(schema.clientContacts.email),
    ))
    .limit(1);
  return contact?.email ?? null;
}

/**
 * Appends to a thread. An internal note stays inside LaunchOS: no email
 * status, no job.
 *
 * "The client can read this" and "this leaves as email" are two separate
 * things, and this is where they are separated on the way out — the mirror of
 * the `direction`/`internal` split `replyAsClient` applies on the way in:
 *
 * - **An email thread** (there is a participant address) is written `queued`
 *   and emits `message.queued`; the worker's `outbound.message` job is the
 *   only thing that talks to a mail server.
 * - **A portal thread** has no address, and needs none: writing the row *is*
 *   the delivery, because the portal is the channel. The message is `outbound`
 *   and `sent` immediately, the case moves to `waiting_client`, and — if the
 *   client has a contact address — a separate courtesy notice is queued
 *   telling them to sign in. The notice carries no part of the reply body, and
 *   its absence never fails the reply.
 */
export async function replyToConversation(db: Db, organisationId: string, input: ReplyToConversationInput) {
  const v = ReplyToConversationInput.parse(input);
  await assertOwned(db, organisationId, schema.conversations, v.conversationId);

  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, v.conversationId), eq(schema.conversations.organisationId, organisationId)));
  if (!conversation) throw new Error(`conversation ${v.conversationId} not found in organisation`);

  // A client replying is not the agency sending mail, so their words never
  // leave LaunchOS as an outbound email whatever the caller passed. The portal
  // does not come through here at all — `replyAsClient` writes an `inbound`
  // row that reopens the case and tells somebody. This is the backstop for any
  // other caller that hands us `actorKind: "client"`.
  const internal = v.internal || v.actorKind === "client";
  const outbound = !internal;

  const [identity] = await db
    .select()
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, conversation.clientId)));

  // Mail needs somebody to address it to. An email thread without one is a
  // broken thread and still throws; a portal thread has none by design.
  const byEmail = outbound && !!conversation.participantEmail;
  if (outbound && !byEmail && conversation.channel === "email") {
    throw new Error("conversation has no participant email to reply to");
  }
  if (byEmail && !identity) throw new Error("client has no support email identity; run ensureEmailIdentity");

  const [ticket] = conversation.ticketId
    ? await db
        .select()
        .from(schema.tickets)
        .where(and(eq(schema.tickets.id, conversation.ticketId), eq(schema.tickets.organisationId, organisationId)))
    : [];

  // Delivered by the portal alone, a reply on a case the client was never
  // shown is a message written to nobody. Refuse it and say so: the case
  // screen carries a "Visible to the client" toggle for exactly this.
  if (outbound && !byEmail && ticket && !ticket.clientVisible) {
    throw new Error("this case is internal; make it visible to the client before replying");
  }

  // Only mail carries a Message-ID to thread against. A client's portal reply
  // is `inbound` too (see reply-as-client.ts) but has no external id, so it
  // must not shadow the last real email and strip the In-Reply-To header.
  const [lastInbound] = byEmail
    ? await db
        .select({ externalId: schema.messages.externalId })
        .from(schema.messages)
        .where(and(
          eq(schema.messages.conversationId, conversation.id),
          eq(schema.messages.direction, "inbound"),
          isNotNull(schema.messages.externalId),
        ))
        .orderBy(desc(schema.messages.createdAt))
        .limit(1)
    : [];

  // Read before the transaction: a missing address is a skipped notice, not a
  // failed reply, so it must not be able to roll the reply back.
  const noticeTo = outbound && !byEmail && identity
    ? await noticeAddress(db, organisationId, conversation.clientId)
    : null;

  const created = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();

    const [message] = await tx.insert(schema.messages).values({
      organisationId,
      conversationId: conversation.id,
      direction: outbound ? "outbound" : "internal",
      authorKind: v.actorKind,
      authorId: v.actorId ?? null,
      body: v.body,
      fromEmail: byEmail ? identity!.address : null,
      toEmail: byEmail ? conversation.participantEmail : null,
      subject: byEmail ? replySubject(conversation.subject) : null,
      rawHeaders: byEmail && lastInbound?.externalId ? { "in-reply-to": lastInbound.externalId } : {},
      // Mail is queued for the worker to send. A portal reply has arrived the
      // moment it is written, so it is stamped delivered here and never joins
      // the outbound queue.
      status: byEmail ? "queued" : outbound ? "sent" : null,
      deliveredAt: outbound && !byEmail ? now : null,
    }).returning();

    await tx.update(schema.conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(schema.conversations.id, conversation.id));

    // The first response on the linked ticket stops the SLA clock. `isNull`
    // makes this a no-op on every later reply without a read-then-write race.
    if (outbound && conversation.ticketId) {
      await tx.update(schema.tickets)
        .set({ firstResponseAt: now, updatedAt: now })
        .where(and(
          eq(schema.tickets.id, conversation.ticketId),
          eq(schema.tickets.organisationId, organisationId),
          isNull(schema.tickets.firstResponseAt),
        ));
    }

    let notice: typeof schema.messages.$inferSelect | undefined;
    if (outbound && !byEmail) {
      if (ticket && AWAITING_CLIENT_FROM.includes(ticket.status)) {
        await tx.update(schema.tickets)
          .set({ status: "waiting_client", updatedAt: now })
          .where(and(eq(schema.tickets.id, ticket.id), eq(schema.tickets.organisationId, organisationId)));
        await tx.insert(schema.ticketEvents).values({
          organisationId,
          ticketId: ticket.id,
          kind: "status_changed",
          actorKind: v.actorKind,
          actorId: v.actorId ?? null,
          data: { from: ticket.status, to: "waiting_client", reason: "replied to the client in the portal" },
        });
      }

      await recordActivity(tx, organisationId, {
        clientId: conversation.clientId,
        actorKind: v.actorKind,
        actorId: v.actorId,
        kind: "support.portal_reply_sent",
        title: `Replied in the portal: ${shortSubject(conversation.subject)}`,
        link: ticket ? `/cases/${ticket.id}` : `/inbox/${conversation.id}`,
      });

      if (noticeTo) {
        const link = v.portalUrl
          ? `\n\n${v.portalUrl}/portal/support${ticket ? `/${ticket.id}` : ""}`
          : "";
        [notice] = await tx.insert(schema.messages).values({
          organisationId,
          conversationId: conversation.id,
          direction: "outbound",
          authorKind: "system",
          authorId: null,
          body: `${NOTICE_BODY}${link}`,
          fromEmail: identity!.address,
          toEmail: noticeTo,
          subject: replySubject(conversation.subject),
          status: "queued",
          // Marks it as the nudge rather than the answer: the portal thread
          // hides it, and anything that later wants to count real replies or
          // suppress duplicates can tell the two apart. `sendQueuedMessage`
          // merges its own send bookkeeping into this object rather than
          // replacing it, so the marker survives delivery.
          metadata: { kind: PORTAL_REPLY_NOTICE_KIND },
        }).returning();
        await recordAudit(tx, organisationId, {
          actorKind: "system", action: "message.queued",
          targetType: "message", targetId: notice!.id, after: notice,
        });
      }
    }

    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId,
      action: byEmail ? "message.queued" : outbound ? "message.sent" : "message.note_added",
      targetType: "message", targetId: message!.id, after: message,
    });
    return { message: message!, notice };
  });

  if (byEmail) await emit({ name: "message.queued", organisationId, messageId: created.message.id });
  if (created.notice) await emit({ name: "message.queued", organisationId, messageId: created.notice.id });
  return created.message;
}
