import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertClientInOrganisation, assertSiteInOrganisation } from "../tenancy/assert-owned.js";
import { queueCaseAcknowledgement } from "./acknowledge-ticket.js";
import { slaDueAt } from "./sla.js";

export const CreateTicketInput = z.object({
  clientId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  // Supplied when the ticket opens onto a thread that already exists — an
  // email conversation, say. Omitted, createTicket makes the conversation.
  conversationId: z.string().uuid().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).optional(),
  source: z.enum(["portal", "email", "agent", "monitor", "manual"]),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateTicketInput = z.input<typeof CreateTicketInput>;

/**
 * The two sources the client themselves originated. A ticket from either is
 * theirs to read in the portal; anything else is agency work until a human
 * shares it.
 */
const CLIENT_ORIGINATED: readonly CreateTicketInput["source"][] = ["portal", "email"];

/** The channel a conversation was opened on, derived from the ticket source. */
function channelFor(source: CreateTicketInput["source"]): "portal" | "email" | "internal" {
  if (source === "portal") return "portal";
  if (source === "email") return "email";
  return "internal";
}

/**
 * The whole of ticket creation, minus the transaction and the emit, so a
 * caller that is already inside a transaction (`ingestInboundEmail`) can make
 * the conversation, the message and the ticket atomically. Callers that use
 * this MUST emit `ticket.created` themselves, after their own commit — and
 * `message.queued` for the `acknowledgement` when there is one, for the same
 * reason: the worker must never be handed a message id the transaction went
 * on to roll back.
 */
export async function createTicketInTx(
  tx: Db,
  organisationId: string,
  input: CreateTicketInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const v = CreateTicketInput.parse(input);
  await assertClientInOrganisation(tx, organisationId, v.clientId);
  if (v.siteId) await assertSiteInOrganisation(tx, organisationId, v.siteId);

  const conversation = v.conversationId
    ? (
        await tx.select().from(schema.conversations)
          .where(and(eq(schema.conversations.id, v.conversationId), eq(schema.conversations.organisationId, organisationId)))
      )[0]
    : (
        await tx.insert(schema.conversations).values({
          organisationId, clientId: v.clientId, siteId: v.siteId ?? null, subject: v.subject,
          channel: channelFor(v.source), lastMessageAt: new Date(),
        }).returning()
      )[0];
  if (!conversation) throw new Error(`conversation ${v.conversationId} not found in organisation`);
  // A conversation id arrives from outside the trust boundary just like any
  // other foreign key: without this, a caller could hang client A's ticket off
  // client B's thread and expose B's messages on A's case page.
  if (conversation.clientId !== v.clientId) {
    throw new Error(`conversation ${conversation.id} belongs to another client`);
  }

  // The opening message is the ticket body only when we made the conversation.
  // An email thread already carries the client's own words.
  //
  // The client's own words are `inbound`, exactly as they are when they arrive
  // by email; a ticket we raised about them opens with an `internal` note.
  // `direction` is what the portal filters on, so this is the line that decides
  // whether the opening body is readable by the client.
  if (!v.conversationId) {
    await tx.insert(schema.messages).values({
      organisationId, conversationId: conversation.id,
      direction: v.actorKind === "client" ? "inbound" : "internal",
      authorKind: v.actorKind, authorId: v.actorId ?? null, body: v.body,
    });
  }

  const [ticket] = await tx.insert(schema.tickets).values({
    organisationId, conversationId: conversation.id, clientId: v.clientId, siteId: v.siteId ?? null,
    subject: v.subject, severity: v.severity, category: v.category ?? null, source: v.source,
    clientVisible: CLIENT_ORIGINATED.includes(v.source),
    slaDueAt: slaDueAt(v.severity, new Date()),
  }).returning();

  // Both sides of the conversation/ticket pair are written here, so
  // `conversations.ticket_id` is never stale.
  const [linked] = await tx.update(schema.conversations)
    .set({ ticketId: ticket!.id, updatedAt: new Date() })
    .where(eq(schema.conversations.id, conversation.id))
    .returning();

  await tx.insert(schema.ticketEvents).values({ organisationId, ticketId: ticket!.id, kind: "created", actorKind: v.actorKind, actorId: v.actorId ?? null });
  await recordAudit(tx, organisationId, { actorKind: v.actorKind, actorId: v.actorId, action: "ticket.created", targetType: "ticket", targetId: ticket!.id, after: ticket });

  // A client who raised this hears back straight away — "we've got it, here is
  // the reference" — from the same transaction, so the case and the promise
  // land together. Nothing for a case staff, a monitor or an agent opened.
  const acknowledgement = await queueCaseAcknowledgement(
    tx,
    organisationId,
    { ticket: ticket!, conversation: linked ?? conversation, actorKind: v.actorKind, actorId: v.actorId },
    env,
  );
  return { ticket: ticket!, conversation: linked ?? conversation, acknowledgement };
}

export async function createTicket(
  db: Db,
  organisationId: string,
  input: CreateTicketInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  // One transaction: a ticket without its conversation, opening message, event
  // or audit row is worse than no ticket at all.
  const created = await db.transaction(async (tx) => createTicketInTx(tx as unknown as Db, organisationId, input, env));

  // Emitted only once the rows are durable — a subscriber must never see a
  // ticket id the transaction went on to roll back.
  await emit({ name: "ticket.created", organisationId, ticketId: created.ticket.id });
  if (created.acknowledgement) {
    await emit({ name: "message.queued", organisationId, messageId: created.acknowledgement.id });
  }
  return created;
}
