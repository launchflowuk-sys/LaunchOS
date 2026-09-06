import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { ensureLeadConversation } from "../leads/acknowledge.js";
import { PROPOSAL_NOTICE_KIND } from "../support/courtesy-notice.js";
import { describePricing, formatPence, type ProposalTotals } from "./pricing.js";
import { ActorKindSchema, formatValidUntil, proposalPublicUrl, type ActorKind, type ProposalRow } from "./shared.js";

/**
 * What a client is told about their proposal, and on which thread.
 *
 * The shape follows `meetings/notices.ts` exactly: one branded email per
 * event, written as a `messages` row inside the caller's transaction, marked
 * as a courtesy notice so no thread reader mistakes it for a turn in the
 * conversation, and actually sent by the outbound worker after the caller
 * emits `message.queued`. Queueing rather than sending is what lets
 * `acceptProposal` stay one transaction: an SMTP call cannot be rolled back,
 * a row can.
 */

type MessageRow = typeof schema.messages.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;

export type ProposalNoticeKind = "sent" | "accepted" | "declined" | "payment";

/** `proposals.metadata.conversationId` — the thread a client's proposal emails file on. */
export const PROPOSAL_CONVERSATION_ID = "conversationId";

/**
 * The thread this proposal's emails file on: the lead's own thread, or — for
 * an existing client — one conversation per proposal, remembered on the row so
 * the acceptance email lands under the offer rather than starting a third
 * thread about the same piece of work.
 */
export async function ensureProposalConversation(db: Db, organisationId: string, proposal: ProposalRow): Promise<ConversationRow> {
  if (proposal.leadId) {
    const [lead] = await db.select().from(schema.leads)
      .where(and(eq(schema.leads.id, proposal.leadId), eq(schema.leads.organisationId, organisationId)));
    if (lead) return ensureLeadConversation(db, organisationId, lead);
  }
  const remembered = proposal.metadata[PROPOSAL_CONVERSATION_ID];
  if (typeof remembered === "string") {
    const [existing] = await db.select().from(schema.conversations)
      .where(and(eq(schema.conversations.id, remembered), eq(schema.conversations.organisationId, organisationId)));
    if (existing) return existing;
  }
  if (!proposal.clientId) throw new Error(`proposal ${proposal.id} has neither a lead nor a client to write to`);
  const now = new Date();
  const [created] = await db.insert(schema.conversations).values({
    organisationId,
    clientId: proposal.clientId,
    subject: `Proposal ${proposal.reference}: ${proposal.title}`,
    channel: "email",
    status: "closed",
    lastMessageAt: now,
  }).returning();
  await db.update(schema.proposals)
    .set({
      metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [PROPOSAL_CONVERSATION_ID]: created!.id })}::jsonb`,
      updatedAt: now,
    })
    .where(eq(schema.proposals.id, proposal.id));
  return created!;
}

export interface QueueProposalNoticeInput {
  proposal: ProposalRow;
  notice: ProposalNoticeKind;
  to: string;
  subject: string;
  body: string;
  /** Stamped on the message so the sender can attach the document and link the page. */
  links?: { proposalUrl?: string | undefined; documentUrl?: string | undefined; documentId?: string | undefined } | undefined;
  actorKind?: ActorKind | undefined;
  actorId?: string | undefined;
}

/**
 * Queues one branded email about a proposal. Runs in the caller's transaction;
 * the caller emits `message.queued` after commit.
 */
export async function queueProposalNotice(db: Db, organisationId: string, input: QueueProposalNoticeInput): Promise<MessageRow> {
  const actorKind = ActorKindSchema.default("system").parse(input.actorKind);
  const conversation = await ensureProposalConversation(db, organisationId, input.proposal);
  const now = new Date();
  const [message] = await db.insert(schema.messages).values({
    organisationId,
    conversationId: conversation.id,
    direction: "outbound",
    authorKind: "system",
    authorId: null,
    body: input.body,
    fromEmail: brandSupportAddress(),
    toEmail: input.to.toLowerCase(),
    subject: input.subject,
    status: "queued",
    metadata: {
      kind: PROPOSAL_NOTICE_KIND,
      notice: input.notice,
      proposalId: input.proposal.id,
      ...(input.links?.proposalUrl ? { proposalUrl: input.links.proposalUrl } : {}),
      ...(input.links?.documentUrl ? { documentUrl: input.links.documentUrl } : {}),
      ...(input.links?.documentId ? { documentId: input.links.documentId } : {}),
    },
  }).returning();
  await db.update(schema.conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(schema.conversations.id, conversation.id));
  await recordAudit(db, organisationId, {
    actorKind, actorId: input.actorId, action: "message.queued", targetType: "message", targetId: message!.id, after: message,
  });
  return message!;
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

/**
 * The stored body of the email that carries a proposal out — the record of
 * what the client was told, in Shoji's own voice: what it is, what it costs,
 * where to read it, and how long it stands.
 */
export function sentBody(
  proposal: ProposalRow,
  totals: ProposalTotals,
  recipientName: string,
  documentUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return [
    `Hi ${firstName(recipientName)},`,
    `Here's the proposal we talked about — ${proposal.title}, reference ${proposal.reference}.`,
    describePricing(totals),
    `Read it and accept it here: ${proposalPublicUrl(proposal, env)}`,
    `The PDF is here if you'd rather keep a copy: ${documentUrl}`,
    ...(proposal.validUntil ? [`It stands until ${formatValidUntil(proposal.validUntil)}. If you need longer, just say.`] : []),
    `Any questions at all, reply to this email.`,
    `Shoji\nLaunchFlow`,
  ].join("\n\n");
}

/** What the client gets the moment they accept: confirmation, and what happens next. */
export function acceptedBody(proposal: ProposalRow, totals: ProposalTotals, acceptedName: string, env: NodeJS.ProcessEnv = process.env): string {
  const next = totals.dueOnAcceptancePence > 0
    ? "We'll send you a payment link for the amount due to start, and get going as soon as it's cleared."
    : "There's nothing to pay today — the first month starts when your site goes live.";
  return [
    `Hi ${firstName(acceptedName)},`,
    `Thanks — that's ${proposal.reference} accepted. ${describePricing(totals)}`,
    next,
    `Your signed copy is on the same page you accepted from: ${proposalPublicUrl(proposal, env)}`,
    `I'll be in touch shortly with the first steps.`,
    `Shoji\nLaunchFlow`,
  ].join("\n\n");
}

/**
 * The payment link, sent by the follow-on job once acceptance has opened a
 * Checkout session.
 *
 * Separate from the acceptance email on purpose: acceptance is one
 * transaction and Stripe is an HTTP call to somebody else's server, so the
 * confirmation goes out the moment they agree and this follows a second
 * later. `acceptedBody` promises exactly this email, so the wording here has
 * to be the other half of that sentence.
 */
export function paymentBody(
  proposal: ProposalRow,
  totals: ProposalTotals,
  recipientName: string,
  checkoutUrl: string,
): string {
  // Only ever sent when something is actually due: a monthly-on-delivery
  // proposal opens no payment step at all, so there is no "£0.00" branch here.
  const what = totals.recurringMonthlyPence > 0
    ? `It takes the ${formatPence(totals.dueOnAcceptancePence)} to start and sets up the ${formatPence(totals.recurringMonthlyPence)} a month in one go, so there is nothing else to sign up for.`
    : `It is a single payment of ${formatPence(totals.dueOnAcceptancePence)}.`;
  return [
    `Hi ${firstName(recipientName)},`,
    `Here is the payment link for ${proposal.reference}.`,
    what,
    checkoutUrl,
    `As soon as it clears I'll start on the first steps. Any questions, reply to this email.`,
    `Shoji\nLaunchFlow`,
  ].join("\n\n");
}

/** A short, gracious acknowledgement when somebody says no. No chasing. */
export function declinedBody(proposal: ProposalRow, recipientName: string): string {
  return [
    `Hi ${firstName(recipientName)},`,
    `Thanks for letting me know about ${proposal.reference} — no problem at all.`,
    `If anything changes, or you'd like a different shape of quote, just reply to this email.`,
    `All the best,\nShoji\nLaunchFlow`,
  ].join("\n\n");
}
