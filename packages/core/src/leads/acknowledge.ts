import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { LEAD_ACKNOWLEDGEMENT_KIND } from "../support/courtesy-notice.js";
import { bookingLinkFor } from "./booking-link.js";

type Lead = typeof schema.leads.$inferSelect;
type Conversation = typeof schema.conversations.$inferSelect;
type Message = typeof schema.messages.$inferSelect;

/** Stamped on `leads.metadata` once the acknowledgement is queued — once per lead. */
export const LEAD_ACKNOWLEDGED_AT = "acknowledgedAt";
/** `leads.metadata` — the thread every email to this lead is filed on. */
export const LEAD_CONVERSATION_ID = "conversationId";

/**
 * The sources a person reached us through on their own: the website form, the
 * self-serve signup, a funnel page, the public API. A lead Shoji typed after a
 * phone call (`manual`), or one a booking minted (`booking`, whose
 * confirmation is its own email), is never acknowledged.
 */
export const ACKNOWLEDGED_LEAD_SOURCES: readonly string[] = ["website", "signup", "funnel", "api"];

/**
 * The thread a lead's emails live on: the acknowledgement, the approved
 * reply and any meeting notice all file here so the lead page shows one
 * conversation. Created on first use, remembered on `leads.metadata`.
 */
export async function ensureLeadConversation(db: Db, organisationId: string, lead: Lead): Promise<Conversation> {
  const remembered = lead.metadata[LEAD_CONVERSATION_ID];
  if (typeof remembered === "string") {
    const [existing] = await db.select().from(schema.conversations)
      .where(and(eq(schema.conversations.id, remembered), eq(schema.conversations.organisationId, organisationId)));
    if (existing) return existing;
  }
  const [byLead] = await db.select().from(schema.conversations)
    .where(and(eq(schema.conversations.organisationId, organisationId), eq(schema.conversations.leadId, lead.id)))
    .limit(1);
  if (byLead) return byLead;

  const now = new Date();
  const [created] = await db.insert(schema.conversations).values({
    organisationId, leadId: lead.id, clientId: null,
    subject: `Enquiry from ${lead.business ?? lead.name}`,
    channel: "email", status: "open", lastMessageAt: now,
    participantEmail: lead.email,
  }).returning();
  await db.update(schema.leads)
    .set({
      metadata: sql`coalesce(${schema.leads.metadata}, '{}'::jsonb) || ${JSON.stringify({ [LEAD_CONVERSATION_ID]: created!.id })}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(schema.leads.id, lead.id), eq(schema.leads.organisationId, organisationId)));
  return created!;
}

/**
 * The stored body — the record of what the lead was told. Plain sentences;
 * the branded shell adds the heading and the "Book a call" button from
 * `metadata.bookingUrl`, so the link appears once as text (for the plain
 * client) and `paragraphsFromBody` drops that line from the HTML.
 */
export function leadAcknowledgementBody(lead: Pick<Lead, "name" | "business">, bookingUrl: string): string {
  const first = lead.name.split(/\s+/)[0] || lead.name;
  return [
    `Hi ${first},`,
    `Thanks for getting in touch${lead.business ? ` about ${lead.business}` : ""} — we've got your enquiry.`,
    `Shoji reads every enquiry himself and you'll have a reply within one working day. If it's quicker to talk it through, pick a time for a call and it goes straight into the diary:`,
    bookingUrl,
    `Speak soon,\nThe LaunchFlow team`,
  ].join("\n\n");
}

/** Already acknowledged — by a previous call, or by a redelivery that healed. */
async function alreadyAcknowledged(db: Db, organisationId: string, lead: Lead): Promise<boolean> {
  if (lead.metadata[LEAD_ACKNOWLEDGED_AT]) return true;
  const [existing] = await db.select({ id: schema.messages.id }).from(schema.messages)
    .where(and(
      eq(schema.messages.organisationId, organisationId),
      sql`${schema.messages.metadata}->>'kind' = ${LEAD_ACKNOWLEDGEMENT_KIND}`,
      sql`${schema.messages.metadata}->>'leadId' = ${lead.id}`,
    ))
    .limit(1);
  return !!existing;
}

export interface QueueLeadAcknowledgementInput {
  lead: Lead;
}

/**
 * Queues the one email a person gets the moment their enquiry lands: thanks,
 * what happens next, and the booking link. Same shape as the case
 * acknowledgement in `support/acknowledge-ticket.ts`: a `queued` outbound
 * `messages` row on the lead's own thread, sent by `sendQueuedMessage` in the
 * branded shell with the support mailbox as Reply-To, marked
 * `metadata.kind = lead_acknowledgement` so no reader mistakes it for a turn
 * in the thread. At most once per lead (`leads.metadata.acknowledgedAt` and
 * the message's own `metadata.leadId`), only for the sources in
 * `ACKNOWLEDGED_LEAD_SOURCES`, only with an address to send to.
 *
 * Runs inside the caller's transaction and never fails it; the caller emits
 * `message.queued` for the returned row after its own commit.
 */
export async function queueLeadAcknowledgement(
  db: Db,
  organisationId: string,
  input: QueueLeadAcknowledgementInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Message | undefined> {
  const { lead } = input;
  if (!lead.email || !ACKNOWLEDGED_LEAD_SOURCES.includes(lead.source)) return undefined;
  if (await alreadyAcknowledged(db, organisationId, lead)) return undefined;

  const conversation = await ensureLeadConversation(db, organisationId, lead);
  const bookingUrl = bookingLinkFor(lead, env);
  const now = new Date();
  const [message] = await db.insert(schema.messages).values({
    organisationId,
    conversationId: conversation.id,
    direction: "outbound",
    authorKind: "system",
    authorId: null,
    body: leadAcknowledgementBody(lead, bookingUrl),
    fromEmail: brandSupportAddress(env),
    toEmail: lead.email,
    subject: "We've got your enquiry",
    status: "queued",
    metadata: { kind: LEAD_ACKNOWLEDGEMENT_KIND, leadId: lead.id, bookingUrl },
  }).returning();

  const stamp = { [LEAD_ACKNOWLEDGED_AT]: now.toISOString(), acknowledgementMessageId: message!.id };
  await db.update(schema.leads)
    .set({
      metadata: sql`coalesce(${schema.leads.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(schema.leads.id, lead.id), eq(schema.leads.organisationId, organisationId)));

  await recordAudit(db, organisationId, {
    actorKind: "system", action: "message.queued", targetType: "message", targetId: message!.id, after: message,
  });
  await recordActivity(db, organisationId, {
    actorKind: "system", kind: "lead.acknowledged",
    title: `Acknowledged ${lead.business ?? lead.name}'s enquiry`,
    body: `Emailed ${lead.email} with the booking link.`,
    link: `/leads/${lead.id}`,
  });
  return message!;
}
