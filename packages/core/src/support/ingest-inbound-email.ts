import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { InboundEmailSchema, type InboundEmail } from "@launchos/channels";
import { and, eq, inArray } from "drizzle-orm";
import { recordActivity } from "../activity/record-activity.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { createTicketInTx } from "./create-ticket.js";

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

function ticketInput(clientId: string, conversationId: string, subject: string, inbound: InboundEmail) {
  return {
    clientId, conversationId, subject, body: inbound.text || subject,
    source: "email" as const, severity: "medium" as const, actorKind: "client" as const, actorId: inbound.from,
  };
}

export async function ingestInboundEmail(
  db: Db,
  organisationId: string,
  raw: InboundEmail,
  env: NodeJS.ProcessEnv = process.env,
) {
  const inbound = InboundEmailSchema.parse(raw) as InboundEmail;
  const identityClientId = await findIdentityClientId(db, organisationId, inbound.to);
  const matched = identityClientId !== null;

  // A provider that redelivers the same payload must not double-post the thread.
  const [duplicate] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.organisationId, organisationId), eq(schema.messages.externalId, inbound.messageId)));
  if (duplicate) return healRedelivery(db, organisationId, inbound, duplicate, matched, env);

  const clientId = identityClientId ?? (await ensureHoldingClientId(db, organisationId));
  const subject = inbound.subject.trim() || "(no subject)";

  // Conversation, message and ticket commit together: a thread whose ticket
  // rolled back would never reach Support Triage and would never be retried,
  // because the message row alone makes the next delivery look like a duplicate.
  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [candidate] = await tx
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.organisationId, organisationId),
          inArray(schema.conversations.externalThreadKey, threadCandidates(inbound)),
        ),
      );

    // Thread keys come off the wire, so a forged In-Reply-To naming another
    // client's Message-ID would otherwise splice this mail into their thread.
    // A key that resolves to a different client starts a fresh conversation.
    const existing = candidate && candidate.clientId === clientId ? candidate : undefined;

    const conversation =
      existing ??
      (
        await tx.insert(schema.conversations).values({
          organisationId, clientId, subject, channel: "email", status: "open",
          // A hijacked key already belongs to the other client's conversation,
          // so the new thread is keyed on this message instead.
          externalThreadKey: inbound.messageId,
          participantEmail: inbound.from, lastMessageAt: new Date(),
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

    const linked = conversation.ticketId
      ? (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, conversation.ticketId)))[0]
      : undefined;
    const reusable = linked && !CLOSED_TICKET_STATUSES.includes(linked.status);

    // createTicketInTx owns the ticket + event + audit, so a new email thread
    // reaches Support Triage down exactly the same path as any other source.
    const created = reusable
      ? undefined
      : await createTicketInTx(tx, organisationId, ticketInput(clientId, conversation.id, subject, inbound), env);
    const ticket = created ? created.ticket : linked!;

    await recordActivity(tx, organisationId, {
      clientId, actorKind: "client", actorId: inbound.from, kind: "support.email_received",
      title: `Email received: ${subject}`, link: `/cases/${ticket.id}`,
    });

    const [fresh] = await tx.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
    return { conversation: fresh!, message: message!, ticket, opened: !reusable, acknowledgement: created?.acknowledgement };
  });

  // After commit: a subscriber must never see an id the transaction rolled back.
  if (result.opened) await emit({ name: "ticket.created", organisationId, ticketId: result.ticket.id });
  if (result.acknowledgement) {
    await emit({ name: "message.queued", organisationId, messageId: result.acknowledgement.id });
  }
  if (!matched) {
    await notifyOwner(db, organisationId, {
      kind: "support.unmatched_inbound",
      title: "Email to an unknown support address",
      body: `From ${inbound.from} to ${inbound.to.join(", ")} — filed under the unmatched holding client.`,
      link: `/inbox/${result.conversation.id}`,
    });
  }

  return { conversation: result.conversation, message: result.message, ticket: result.ticket, matched };
}

/**
 * The payload is already stored. Return what we have — and open the ticket the
 * thread is missing rather than throwing, so a delivery interrupted between the
 * message and its ticket heals on the provider's next retry instead of leaving
 * a thread nobody is working.
 */
async function healRedelivery(
  db: Db,
  organisationId: string,
  inbound: InboundEmail,
  duplicate: typeof schema.messages.$inferSelect,
  matched: boolean,
  env: NodeJS.ProcessEnv,
) {
  const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, duplicate.conversationId));
  if (!conversation) throw new Error(`conversation ${duplicate.conversationId} not found in organisation`);

  const linked = conversation.ticketId
    ? (await db.select().from(schema.tickets).where(eq(schema.tickets.id, conversation.ticketId)))[0]
    : undefined;
  if (linked) return { conversation, message: duplicate, ticket: linked, matched };

  // An email thread always belongs to a client (a lead thread is opened by
  // the lead workflow, never by inbound mail), so a missing client here is a
  // broken row rather than a case to heal.
  if (!conversation.clientId) throw new Error(`conversation ${conversation.id} has no client to open a ticket for`);
  const healed = await db.transaction(async (txRaw) =>
    createTicketInTx(
      txRaw as unknown as Db,
      organisationId,
      ticketInput(conversation.clientId!, conversation.id, conversation.subject, inbound),
      env,
    ),
  );
  await emit({ name: "ticket.created", organisationId, ticketId: healed.ticket.id });
  if (healed.acknowledgement) {
    await emit({ name: "message.queued", organisationId, messageId: healed.acknowledgement.id });
  }
  return { conversation: healed.conversation, message: duplicate, ticket: healed.ticket, matched };
}
