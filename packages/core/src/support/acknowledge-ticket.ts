import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress, firstResponseHours } from "../config.js";
import { CASE_ACKNOWLEDGEMENT_KIND } from "./courtesy-notice.js";
import { replySubject } from "./subject.js";

type Ticket = typeof schema.tickets.$inferSelect;
type Conversation = typeof schema.conversations.$inferSelect;
type Message = typeof schema.messages.$inferSelect;

/** The two sources a client raises a case from. Anything else is agency work. */
const CLIENT_SOURCES: readonly Ticket["source"][] = ["portal", "email"];

/** Stamped on `tickets.metadata` once the acknowledgement is queued. */
export const ACKNOWLEDGED_AT = "acknowledgedAt";

/**
 * The reference a client sees for a case: the first eight characters of the
 * id, upper-cased. Tickets have no sequential number, and a uuid on a phone
 * screen is unreadable; eight hex characters are unique enough to quote back
 * to support and short enough to read aloud.
 */
export function caseReference(ticketId: string): string {
  return ticketId.slice(0, 8).toUpperCase();
}

export interface QueueCaseAcknowledgementInput {
  ticket: Ticket;
  conversation: Conversation;
  actorKind: "user" | "client" | "agent" | "system";
  actorId?: string | undefined;
}

/**
 * The address the acknowledgement goes to: the person who raised the case.
 *
 * An email thread carries the sender on the conversation. A portal ticket's
 * `actorId` is the Better Auth user id of the portal user, so the address is
 * theirs; if that lookup finds nothing (an older seed, a test fixture) the
 * client record's own address is the next best "you", and null is a normal
 * answer that simply means nobody is emailed.
 */
async function requesterAddress(db: Db, organisationId: string, input: QueueCaseAcknowledgementInput): Promise<string | null> {
  const { ticket, conversation, actorId } = input;
  if (ticket.source === "email") return conversation.participantEmail ?? null;

  if (actorId) {
    const [user] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, actorId)).limit(1);
    if (user?.email) return user.email;
  }
  const [client] = await db
    .select({ email: schema.clients.email })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, ticket.clientId), eq(schema.clients.organisationId, organisationId)));
  return client?.email ?? null;
}

/** Already acknowledged — by a previous call, or by a redelivery that healed. */
async function alreadyAcknowledged(db: Db, organisationId: string, ticket: Ticket): Promise<boolean> {
  if (ticket.metadata[ACKNOWLEDGED_AT]) return true;
  const [existing] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(
      eq(schema.messages.organisationId, organisationId),
      sql`${schema.messages.metadata}->>'kind' = ${CASE_ACKNOWLEDGEMENT_KIND}`,
      sql`${schema.messages.metadata}->>'ticketId' = ${ticket.id}`,
    ))
    .limit(1);
  return !!existing;
}

/**
 * Queues the one email a client gets the moment they raise a case: "we've got
 * your request", the reference, and how long a reply takes.
 *
 * Only for a case the client themselves raised — `actorKind: "client"` from the
 * portal or by email. A ticket the monitor, an agent or a colleague opened
 * about a client is agency work until somebody shares it, and acknowledging it
 * would tell the client about a case they cannot see.
 *
 * It is written as a `queued` outbound message on the case's own conversation
 * so `sendQueuedMessage` — the only thing that talks to a mail server — sends
 * it with the branded shell, and so the record of what the client was told
 * sits with the case. `metadata.kind` marks it as a notice rather than a turn
 * in the thread: `isCourtesyNotice` keeps it off every thread reader and out
 * of the Inbox's "who spoke last", and nothing here touches
 * `tickets.first_response_at` — an automatic acknowledgement is not a response,
 * and the SLA clock keeps running until a person answers.
 *
 * At most once per ticket: `tickets.metadata.acknowledgedAt` and the message's
 * own `metadata.ticketId` are both checked, so a redelivery that heals a
 * missing ticket cannot email twice.
 *
 * Runs inside the caller's transaction and never fails it: a missing address
 * (a portal user we cannot resolve, an unmatched inbound sender) is a skipped
 * notice, and the caller must emit `message.queued` for the row this returns
 * only after its own commit.
 */
export async function queueCaseAcknowledgement(
  db: Db,
  organisationId: string,
  input: QueueCaseAcknowledgementInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Message | undefined> {
  const { ticket, conversation, actorKind } = input;
  if (actorKind !== "client" || !CLIENT_SOURCES.includes(ticket.source)) return undefined;
  if (await alreadyAcknowledged(db, organisationId, ticket)) return undefined;

  const to = await requesterAddress(db, organisationId, input);
  if (!to) return undefined;

  const [identity] = await db
    .select({ address: schema.emailIdentities.address })
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, ticket.clientId)));
  // An email that reached us at an address we do not route (the "unmatched"
  // holding client) came from somebody we cannot vouch for; a reply from the
  // agency to an unknown sender is not an acknowledgement, it is a bounce
  // target. Portal users are known, so they get the generic address.
  if (ticket.source === "email" && !identity) return undefined;
  const from = identity?.address ?? brandSupportAddress(env);

  const [organisation] = await db
    .select({ metadata: schema.organisations.metadata })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  const hours = firstResponseHours(organisation?.metadata);

  // Threaded under the client's own email where there is one, so their mail
  // client files the acknowledgement with the message it acknowledges.
  const [lastInbound] = ticket.source === "email"
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

  const now = new Date();
  const [message] = await db.insert(schema.messages).values({
    organisationId,
    conversationId: conversation.id,
    direction: "outbound",
    authorKind: "system",
    authorId: null,
    body: acknowledgementBody(ticket, hours),
    fromEmail: from,
    toEmail: to,
    subject: replySubject(ticket.subject),
    rawHeaders: lastInbound?.externalId ? { "in-reply-to": lastInbound.externalId } : {},
    status: "queued",
    // `sendQueuedMessage` reads `kind` for the heading and the button, and
    // merges its own bookkeeping into this object rather than replacing it.
    metadata: { kind: CASE_ACKNOWLEDGEMENT_KIND, ticketId: ticket.id, hours },
  }).returning();

  const stamp = { [ACKNOWLEDGED_AT]: now.toISOString(), acknowledgementMessageId: message!.id };
  await db.update(schema.tickets)
    .set({
      metadata: sql`coalesce(${schema.tickets.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(schema.tickets.id, ticket.id), eq(schema.tickets.organisationId, organisationId)));

  await recordAudit(db, organisationId, {
    actorKind: "system", action: "message.queued", targetType: "message", targetId: message!.id, after: message,
  });
  return message!;
}

/**
 * The stored body — the record of what the client was told. The branded
 * version rendered at send time takes its heading and button from
 * `metadata.kind`, so this carries only the sentences.
 */
export function acknowledgementBody(ticket: Pick<Ticket, "id" | "subject">, hours: number): string {
  const unit = hours === 1 ? "hour" : "hours";
  return (
    `Thanks — your case '${ticket.subject}' is open as #${caseReference(ticket.id)}. ` +
    `We aim to reply within ${hours} ${unit} (working hours). You'll get an email when we do.`
  );
}
