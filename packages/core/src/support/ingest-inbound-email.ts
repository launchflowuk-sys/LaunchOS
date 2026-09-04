import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { InboundEmailSchema, type InboundEmail } from "@launchos/channels";
import { and, eq, inArray } from "drizzle-orm";
import { recordActivity } from "../activity/record-activity.js";
import { notifyOwner } from "../notifications/notify.js";
import { createTicket } from "./create-ticket.js";

export const HOLDING_CLIENT_SLUG = "unmatched";
const HOLDING_CLIENT_NAME = "Unmatched inbound";
const CLOSED_TICKET_STATUSES: readonly string[] = ["resolved", "closed"];

/** Thread keys we accept as "same conversation", most specific first. */
function threadCandidates(inbound: InboundEmail): string[] {
  return [...new Set([inbound.inReplyTo, ...inbound.references, inbound.messageId].filter((v): v is string => !!v))];
}

/** The client whose support address one of the recipients is, if any. */
async function findIdentityClientId(db: Db, organisationId: string, to: string[]): Promise<string | null> {
  const addresses = to.map((a) => a.trim().toLowerCase());
  const [identity] = await db
    .select({ clientId: schema.emailIdentities.clientId })
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), inArray(schema.emailIdentities.address, addresses)));
  return identity?.clientId ?? null;
}

/**
 * Mail to an address we do not route still has to land somewhere a human can
 * see it, so the holding client is created on demand rather than depending on
 * the seed having run. `onConflictDoNothing` keeps two concurrent deliveries
 * from racing to insert it.
 */
async function ensureHoldingClientId(db: Db, organisationId: string): Promise<string> {
  const where = and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.slug, HOLDING_CLIENT_SLUG));
  const [existing] = await db.select({ id: schema.clients.id }).from(schema.clients).where(where);
  if (existing) return existing.id;

  // No support_email: the holding client is a bucket, not a routable client.
  await db
    .insert(schema.clients)
    .values({ organisationId, name: HOLDING_CLIENT_NAME, slug: HOLDING_CLIENT_SLUG })
    .onConflictDoNothing({ target: [schema.clients.organisationId, schema.clients.slug] });

  const [created] = await db.select({ id: schema.clients.id }).from(schema.clients).where(where);
  if (!created) throw new Error(`could not create the "${HOLDING_CLIENT_SLUG}" holding client`);
  return created.id;
}

export async function ingestInboundEmail(db: Db, organisationId: string, raw: InboundEmail) {
  const inbound = InboundEmailSchema.parse(raw) as InboundEmail;
  const identityClientId = await findIdentityClientId(db, organisationId, inbound.to);
  const matched = identityClientId !== null;

  // A provider that redelivers the same payload must not double-post the thread.
  const [duplicate] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.organisationId, organisationId), eq(schema.messages.externalId, inbound.messageId)));
  if (duplicate) {
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, duplicate.conversationId));
    if (!conversation?.ticketId) throw new Error(`conversation for message ${duplicate.id} has no ticket`);
    const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, conversation.ticketId));
    return { conversation, message: duplicate, ticket: ticket!, matched };
  }

  const clientId = identityClientId ?? (await ensureHoldingClientId(db, organisationId));
  const subject = inbound.subject.trim() || "(no subject)";

  const appended = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.organisationId, organisationId),
          inArray(schema.conversations.externalThreadKey, threadCandidates(inbound)),
        ),
      );

    const conversation =
      existing ??
      (
        await tx.insert(schema.conversations).values({
          organisationId, clientId, subject, channel: "email", status: "open",
          externalThreadKey: inbound.messageId, participantEmail: inbound.from, lastMessageAt: new Date(),
        }).returning()
      )[0]!;

    const [message] = await tx.insert(schema.messages).values({
      organisationId, conversationId: conversation.id, direction: "inbound", authorKind: "client", authorId: inbound.from,
      body: inbound.text, bodyHtml: inbound.html ?? null, externalId: inbound.messageId,
      fromEmail: inbound.from, toEmail: inbound.to[0]!, subject, rawHeaders: inbound.rawHeaders,
      attachments: inbound.attachments, status: "received", deliveredAt: new Date(),
    }).returning();

    await tx.update(schema.conversations)
      .set({ lastMessageAt: new Date(), status: "open", updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversation.id));

    return { conversation, message: message! };
  });

  const linked = appended.conversation.ticketId
    ? (await db.select().from(schema.tickets).where(eq(schema.tickets.id, appended.conversation.ticketId)))[0]
    : undefined;
  const reusable = linked && !CLOSED_TICKET_STATUSES.includes(linked.status);

  // createTicket owns the ticket + event + audit + `ticket.created` emit, so a
  // new email thread reaches Support Triage down exactly the same path as any
  // other ticket source.
  const ticket = reusable
    ? linked
    : (
        await createTicket(db, organisationId, {
          clientId, conversationId: appended.conversation.id, subject, body: inbound.text || subject,
          source: "email", severity: "medium", actorKind: "client", actorId: inbound.from,
        })
      ).ticket;

  await recordActivity(db, organisationId, {
    clientId, actorKind: "client", actorId: inbound.from, kind: "support.email_received",
    title: `Email received: ${subject}`, link: `/cases/${ticket.id}`,
  });
  if (!matched) {
    await notifyOwner(db, organisationId, {
      kind: "support.unmatched_inbound",
      title: "Email to an unknown support address",
      body: `From ${inbound.from} to ${inbound.to.join(", ")} — filed under the unmatched holding client.`,
      link: `/inbox/${appended.conversation.id}`,
    });
  }

  const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, appended.conversation.id));
  return { conversation: conversation!, message: appended.message, ticket, matched };
}
