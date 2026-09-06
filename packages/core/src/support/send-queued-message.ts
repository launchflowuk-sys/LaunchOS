import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { paragraphsFromBody, renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandEmailContext, inboundEmailEnabled, replyMailbox } from "../config.js";
import { notifyOwner } from "../notifications/notify.js";
import { PROJECT_PORTAL_PATH } from "../projects/shared.js";
import { MAX_ADDRESS_CHARS, MAX_ERROR_CHARS, truncate } from "../text.js";
import {
  CASE_ACKNOWLEDGEMENT_KIND, CLIENT_REPORT_NOTICE_KIND, CONTENT_REPORT_NOTICE_KIND, CSAT_INVITE_KIND,
  DELIVERY_NOTICE_KIND, LEAD_ACKNOWLEDGEMENT_KIND, MEETING_NOTICE_KIND,
  PORTAL_REPLY_NOTICE_KIND, PROJECT_MILESTONE_NOTICE_KIND, PROJECT_UPDATE_NOTICE_KIND, PROPOSAL_NOTICE_KIND,
  SUBSCRIPTION_CHANGE_NOTICE_KIND,
} from "./courtesy-notice.js";

/**
 * `metadata.kind` on the Lead Qualifier's approved first reply. Not a courtesy
 * notice — it *is* the answer — but it goes to somebody with no portal and no
 * case, so its shell differs from a support reply: the button is the booking
 * link the body already carries, and there is no "sign in to reply" note.
 */
export const LEAD_REPLY_KIND = "lead_reply";

export const SendQueuedMessageInput = z.object({ messageId: z.string().uuid() });
export type SendQueuedMessageInput = z.input<typeof SendQueuedMessageInput>;

/** A worker that dies mid-send holds its claim no longer than this. */
export const CLAIM_TTL_MINUTES = 5;
/** After this many failed attempts the message stops being retried. */
export const MAX_SEND_ATTEMPTS = 5;

type Message = typeof schema.messages.$inferSelect;

function attemptsOf(message: Message): number {
  const raw = message.metadata["attempts"];
  return typeof raw === "number" ? raw : 0;
}

/** Metadata with the claim removed, so the next worker can take the message. */
function released(metadata: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...metadata };
  delete copy["claimedAt"];
  return copy;
}

async function patchMessage(db: Db, organisationId: string, messageId: string, patch: Record<string, unknown>) {
  const [row] = await db
    .update(schema.messages)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.organisationId, organisationId)))
    .returning();
  return row!;
}

/**
 * Takes the message only if it is still queued and unclaimed (or the previous
 * claim has gone stale). One UPDATE ... RETURNING, so two workers racing on the
 * same pg-boss job cannot both get a row and send the mail twice — a read-then-
 * act guard has a window between the read and the send where both pass.
 */
async function claim(db: Db, organisationId: string, messageId: string): Promise<Message | undefined> {
  const claimedAt = new Date().toISOString();
  const [row] = await db
    .update(schema.messages)
    .set({
      metadata: sql`coalesce(${schema.messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ claimedAt })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.messages.organisationId, organisationId),
        eq(schema.messages.status, "queued"),
        sql`(
          ${schema.messages.metadata}->>'claimedAt' IS NULL
          OR (${schema.messages.metadata}->>'claimedAt')::timestamptz < now() - (${CLAIM_TTL_MINUTES} * interval '1 minute')
        )`,
      ),
    )
    .returning();
  return row;
}

interface ConversationContext {
  /** Null on a lead thread — a prospect who is not yet a client. */
  clientId: string | null;
  subject: string;
  ticketId: string | null;
}

/**
 * What the thread this message belongs to is about, and whether it has a case
 * behind it. One read serves both the branded email (heading and "View your
 * case" button) and the give-up announcement below, which needs the client id.
 */
async function conversationContext(
  db: Db,
  organisationId: string,
  conversationId: string,
): Promise<ConversationContext | undefined> {
  const [row] = await db
    .select({
      clientId: schema.conversations.clientId,
      subject: schema.conversations.subject,
      ticketId: schema.conversations.ticketId,
    })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.organisationId, organisationId)));
  return row;
}

/** The line a phone shows beside the subject: the opening of the reply itself. */
function preheaderFrom(body: string): string {
  const first = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return first.trim().slice(0, 140);
}

/**
 * The heading, the preheader and the button for one message, decided by
 * `metadata.kind`. A reply has none of its own: its heading is the case subject
 * and its button opens the case. Every notice kind says what it is instead.
 */
interface Presentation {
  preheader: string;
  heading: string;
  cta?: { label: string; url: string } | undefined;
  footerNote?: string | undefined;
}

function presentationFor(
  message: Message,
  context: ConversationContext | undefined,
  appUrl: string,
  inbound: boolean,
): Presentation {
  const kind = message.metadata["kind"];
  const caseUrl = context?.ticketId ? `${appUrl}/portal/support/${context.ticketId}` : undefined;
  const caseHeading = context?.subject ?? message.subject ?? "Your support case";

  if (kind === PORTAL_REPLY_NOTICE_KIND) {
    return {
      preheader: "There is a reply waiting in your portal.",
      heading: caseHeading,
      cta: caseUrl ? { label: "Read the reply", url: caseUrl } : undefined,
    };
  }
  if (kind === CASE_ACKNOWLEDGEMENT_KIND) {
    return {
      preheader: preheaderFrom(message.body),
      heading: "We've got your request",
      cta: caseUrl ? { label: "View your case", url: caseUrl } : undefined,
      footerNote: inbound
        ? "Reply to this email if you have anything to add and it lands on the same case."
        : "If you have anything to add, sign in to your portal and reply on the case.",
    };
  }
  if (kind === SUBSCRIPTION_CHANGE_NOTICE_KIND) {
    const approved = message.metadata["decision"] === "approved";
    return {
      preheader: approved ? "LaunchFlow has approved your plan change request." : "LaunchFlow has answered your plan change request.",
      heading: approved ? "Your request has been approved" : "Your request has been declined",
      cta: { label: "View your plan", url: `${appUrl}/portal/plan` },
    };
  }
  if (kind === CSAT_INVITE_KIND) {
    const ticketId = typeof message.metadata["ticketId"] === "string" ? message.metadata["ticketId"] : context?.ticketId;
    return {
      preheader: "Your case has been resolved — how did we do?",
      heading: "Was this sorted?",
      cta: ticketId ? { label: "Rate your experience", url: `${appUrl}/portal/support/${ticketId}/rate` } : undefined,
      footerNote: "If it is not actually sorted, reply on the case in your portal and we will pick it straight back up.",
    };
  }
  if (kind === LEAD_ACKNOWLEDGEMENT_KIND || kind === LEAD_REPLY_KIND) {
    const bookingUrl = typeof message.metadata["bookingUrl"] === "string" ? message.metadata["bookingUrl"] : undefined;
    return {
      preheader: kind === LEAD_REPLY_KIND ? preheaderFrom(message.body) : "Thanks for getting in touch — here is what happens next.",
      heading: kind === LEAD_REPLY_KIND ? (message.subject ?? caseHeading) : "We've got your enquiry",
      cta: bookingUrl ? { label: "Book a call", url: bookingUrl } : undefined,
      footerNote: inbound
        ? "Reply to this email and it comes straight to Shoji."
        : "Reply to this email and it comes straight to us.",
    };
  }
  if (kind === MEETING_NOTICE_KIND) {
    const notice = typeof message.metadata["notice"] === "string" ? message.metadata["notice"] : "confirmation";
    const joinUrl = typeof message.metadata["joinUrl"] === "string" ? message.metadata["joinUrl"] : undefined;
    const manageUrl = typeof message.metadata["manageUrl"] === "string" ? message.metadata["manageUrl"] : undefined;
    const bookingUrl = typeof message.metadata["bookingUrl"] === "string" ? message.metadata["bookingUrl"] : undefined;
    const headings: Record<string, string> = {
      confirmation: "Your call is booked",
      reminder: "Your call is coming up",
      rescheduled: "Your call has moved",
      cancelled: "Your call has been cancelled",
      no_show: "Sorry we missed you",
    };
    const cta = notice === "cancelled" || notice === "no_show"
      ? (bookingUrl ? { label: "Book another time", url: bookingUrl } : undefined)
      : (joinUrl ? { label: "Join the call", url: joinUrl } : undefined);
    return {
      preheader: preheaderFrom(message.body),
      heading: headings[notice] ?? "Your call",
      cta,
      footerNote: manageUrl && notice !== "cancelled" && notice !== "no_show"
        ? `Need to change or cancel? Use this link: ${manageUrl}`
        : "Reply to this email if you have any questions.",
    };
  }
  if (kind === PROPOSAL_NOTICE_KIND) {
    const notice = typeof message.metadata["notice"] === "string" ? message.metadata["notice"] : "sent";
    const proposalUrl = typeof message.metadata["proposalUrl"] === "string" ? message.metadata["proposalUrl"] : undefined;
    const checkoutUrl = typeof message.metadata["checkoutUrl"] === "string" ? message.metadata["checkoutUrl"] : undefined;
    const headings: Record<string, string> = {
      sent: "Your proposal is ready",
      accepted: "That's agreed — thank you",
      declined: "Thanks for letting us know",
      payment: "Your payment link",
    };
    // The button is the one thing the client is meant to do next: read and
    // accept it, or pay it. A declined proposal has no next step, so it has
    // no button — chasing is Shoji's to do, not the shell's.
    const cta = notice === "payment"
      ? (checkoutUrl ? { label: "Pay securely", url: checkoutUrl } : undefined)
      : notice === "declined"
        ? undefined
        : (proposalUrl ? { label: notice === "accepted" ? "See your signed copy" : "Read the proposal", url: proposalUrl } : undefined);
    return {
      preheader: preheaderFrom(message.body),
      heading: headings[notice] ?? "Your proposal",
      cta,
      footerNote: "Reply to this email with any questions and it comes straight to Shoji.",
    };
  }
  if (kind === PROJECT_UPDATE_NOTICE_KIND || kind === PROJECT_MILESTONE_NOTICE_KIND) {
    // Both go to the client's progress page, because that is the one place the
    // whole plan is — and it is deliberately an invitation, not an instruction:
    // there is nothing on that page a client has to do.
    const projectId = typeof message.metadata["projectId"] === "string" ? message.metadata["projectId"] : undefined;
    const milestone = kind === PROJECT_MILESTONE_NOTICE_KIND;
    return {
      preheader: milestone ? "One more thing off the list." : "Where your project got to this week.",
      heading: message.subject ?? (milestone ? "Another step done" : "Your project update"),
      cta: projectId ? { label: "See your progress", url: `${appUrl}${PROJECT_PORTAL_PATH}/${projectId}` } : undefined,
      footerNote: "Reply to this email with any questions and it comes straight to Shoji.",
    };
  }
  if (kind === DELIVERY_NOTICE_KIND) {
    // The button is the sign-off page, not the PDF: reading the report is the
    // means, signing it off is the thing the client is being asked to do. The
    // document link is in the body for anyone who would rather open the PDF
    // first, and both are in `metadata` for a sender that grows attachments.
    const signOffUrl = typeof message.metadata["signOffUrl"] === "string" ? message.metadata["signOffUrl"] : undefined;
    return {
      preheader: "Your build is finished — here is everything about it.",
      heading: message.subject ?? "Your handover",
      cta: signOffUrl ? { label: "Read it and sign off", url: signOffUrl } : undefined,
      footerNote: "Anything in it that looks wrong? Reply to this email and it comes straight to Shoji.",
    };
  }
  if (kind === CLIENT_REPORT_NOTICE_KIND) {
    const month = typeof message.metadata["monthName"] === "string" ? message.metadata["monthName"] : "last month";
    const documentUrl = typeof message.metadata["documentUrl"] === "string" ? message.metadata["documentUrl"] : undefined;
    return {
      preheader: `Your ${month} in one page.`,
      heading: `Your account report for ${month}`,
      cta: documentUrl
        ? { label: "Open your report", url: documentUrl }
        : { label: "See your reports", url: `${appUrl}/portal/reports` },
    };
  }
  if (kind === CONTENT_REPORT_NOTICE_KIND) {
    const month = typeof message.metadata["monthName"] === "string" ? message.metadata["monthName"] : "this month";
    return {
      preheader: `What LaunchFlow published for you in ${month}.`,
      heading: `Your content for ${month}`,
      cta: { label: "See your posts", url: `${appUrl}/portal/content` },
    };
  }
  return {
    preheader: preheaderFrom(message.body),
    heading: caseHeading,
    cta: caseUrl ? { label: "View your case", url: caseUrl } : undefined,
    footerNote: inbound
      ? "Reply to this email and your answer lands on the same case."
      : "To reply, sign in to your portal so your answer stays on this case.",
  };
}

/**
 * The branded shell around one queued message.
 *
 * Every kind of outbound mail comes through here, because each is a `messages`
 * row and this is the only place in LaunchOS that hands one to a mail server:
 *
 * - **A staff or agent reply.** Heading is the case subject (the conversation's,
 *   not the message's `Re: ...`), body is the reply, and the button goes to the
 *   case in the portal when there is a ticket behind the thread.
 * - **The courtesy notice** `replyToConversation` queues when a portal reply
 *   lands — `metadata.kind` marks it. It says "there is something waiting",
 *   never the answer, so it gets its own heading and its own button label. Its
 *   stored body ends with the portal URL on a line of its own (that body is the
 *   record of what the client was told); `paragraphsFromBody` drops that line
 *   here so the branded version does not show the same link twice, once as text
 *   and once as a button.
 * - **The case acknowledgement** `queueCaseAcknowledgement` writes the moment a
 *   client raises a case, and **the plan change notice**
 *   `applySubscriptionChangeDecision` writes when a request is decided. Each
 *   carries its own heading and button — see `presentationFor`.
 *
 * The footer address is the client's own support identity rather than the
 * generic one: a reply to it threads back onto this case.
 */
function brandedMessageEmail(
  message: Message,
  context: ConversationContext | undefined,
  env: NodeJS.ProcessEnv,
): { text: string; html: string } {
  const brand = brandEmailContext(env);
  const inbound = inboundEmailEnabled(env);
  const shape = presentationFor(message, context, brand.appUrl, inbound);

  return renderBrandedEmail({
    preheader: shape.preheader,
    heading: shape.heading,
    paragraphs: paragraphsFromBody(message.body, shape.cta?.url),
    ...(shape.cta ? { cta: shape.cta } : {}),
    ...(shape.footerNote ? { footerNote: shape.footerNote } : {}),
    logoUrl: brand.logoUrl,
    appUrl: brand.appUrl,
    // With inbound routing on, the client's own support identity: a reply to it
    // threads back onto this case. With it off, that address bounces, so the
    // footer shows the mailbox we really send from instead.
    supportEmail: inbound ? (message.fromEmail ?? brand.supportEmail) : replyMailbox(env),
  });
}

/** Set once a give-up has been announced, so the announcement cannot be doubled. */
const SEND_FAILURE_NOTIFIED = "sendFailureNotifiedAt";

/**
 * A reply that has spent every attempt and will not be sent.
 *
 * Without this the give-up is silent: the message flips to `failed`, one
 * `audit_log` row is written and that is the end of it — the reply still renders
 * on the thread exactly like a delivered one, `outbound.sweep` deliberately only
 * looks at `queued` rows, and the first anyone hears of it is the client chasing
 * a case that looks, from the inside, like it was answered.
 *
 * So it gets the same treatment `invoice.send_failed` and `ad_report.send_failed`
 * already have: an entry on the client's timeline and one notification for the
 * owner. Announced *before* the marker is stamped, deliberately — a crash
 * between the two costs a duplicate notification, and a duplicate is far cheaper
 * than a give-up nobody hears about.
 *
 * The two client-controlled strings — `toEmail`, copied off an inbound message's
 * `From` header, and the relay's own error — are capped by `MAX_ADDRESS_CHARS`
 * and `MAX_ERROR_CHARS` from `../text.js`, which carries the reasoning. An
 * over-long one used to make this throw; see the wrapper at the call site for
 * what that cost. The caps live in `text.ts` rather than here because
 * `apps/worker/src/jobs/outbound-sweep.ts` builds the same title from the same
 * column and needs the same bound.
 */
async function announceSendFailure(db: Db, organisationId: string, message: Message, lastError: string) {
  const conversation = await conversationContext(db, organisationId, message.conversationId);
  const to = truncate(message.toEmail ?? "the client", MAX_ADDRESS_CHARS);
  const link = `/inbox/${message.conversationId}`;
  const title = `A reply to ${to} was never sent`;
  const body = `${MAX_SEND_ATTEMPTS} send attempts failed and the message has been given up on. Last error: ${truncate(lastError, MAX_ERROR_CHARS)}`;
  await recordActivity(db, organisationId, {
    ...(conversation?.clientId ? { clientId: conversation.clientId } : {}),
    actorKind: "system",
    kind: "message.send_failed",
    title,
    body,
    link,
  });
  await notifyOwner(db, organisationId, { kind: "message.send_failed", title, body, link });
  await db
    .update(schema.messages)
    .set({
      metadata: sql`coalesce(${schema.messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ [SEND_FAILURE_NOTIFIED]: new Date().toISOString() })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.messages.id, message.id), eq(schema.messages.organisationId, organisationId)));
}

/**
 * Sends one queued message through the adapter. Called by the worker's
 * `outbound.message` job, which is the only thing in LaunchOS that talks to a
 * mail server. Safe to call twice: the second call finds no claim to take.
 */
export async function sendQueuedMessage(
  db: Db,
  organisationId: string,
  input: SendQueuedMessageInput,
  adapter: EmailAdapter,
  env: NodeJS.ProcessEnv = process.env,
) {
  const v = SendQueuedMessageInput.parse(input);
  const [message] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.id, v.messageId), eq(schema.messages.organisationId, organisationId)));
  if (!message) throw new Error(`message ${v.messageId} not found in organisation`);
  if (!message.toEmail || !message.fromEmail) throw new Error(`message ${v.messageId} is not addressable`);

  // Already sent, already given up on, or in another worker's hands.
  const claimed = await claim(db, organisationId, v.messageId);
  if (!claimed) return message;

  const inReplyTo = claimed.rawHeaders["in-reply-to"];
  // Read outside the try: a thread that has lost its conversation row is a
  // broken message, not a send failure, and must not burn a send attempt.
  const context = await conversationContext(db, organisationId, claimed.conversationId);
  const { text, html } = brandedMessageEmail(claimed, context, env);
  try {
    const result = await adapter.send({
      to: claimed.toEmail!,
      // The envelope sender is the verified MAIL_FROM. The client's own support
      // address is the Reply-To so their answer threads back to them — but only
      // once inbound routing is live; before that it would bounce, so replies
      // go to the mailbox we send from.
      from: env.MAIL_FROM ?? claimed.fromEmail!,
      replyTo: inboundEmailEnabled(env) ? claimed.fromEmail! : replyMailbox(env),
      subject: claimed.subject ?? "(no subject)",
      // Both halves, always. A mail client that will not render HTML, a screen
      // reader in plain mode and a spam filter all read the text alternative,
      // and an HTML-only message scores worse with the last of those.
      text,
      html,
      inReplyTo,
      references: inReplyTo ? [inReplyTo] : undefined,
    });
    const sent = await patchMessage(db, organisationId, v.messageId, {
      status: "sent", deliveredAt: new Date(), externalId: result.providerMessageId, metadata: released(claimed.metadata),
    });
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "message.sent", targetType: "message", targetId: v.messageId, before: message, after: sent,
    });
    return sent;
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    const attempts = attemptsOf(claimed) + 1;
    const exhausted = attempts >= MAX_SEND_ATTEMPTS;
    // The claim is released either way, so a transient failure is retryable by
    // the next pg-boss attempt rather than stuck behind a claim nobody holds.
    const after = await patchMessage(db, organisationId, v.messageId, {
      status: exhausted ? "failed" : "queued",
      metadata: { ...released(claimed.metadata), attempts, lastError },
    });
    await recordAudit(db, organisationId, {
      actorKind: "system",
      action: exhausted ? "message.send_failed" : "message.send_retry",
      targetType: "message", targetId: v.messageId, before: message, after,
    });
    // Exhausted is a terminal state, not a job failure: rethrowing would make
    // pg-boss retry a message we have already given up on.
    if (exhausted) {
      if (typeof claimed.metadata[SEND_FAILURE_NOTIFIED] !== "string") {
        // The alert must never be able to fail the job that is recording the
        // give-up. A throw here escaped, pg-boss retried, `claim()` refused the
        // now-`failed` row and returned early — and the message, which
        // `outbound.sweep` never sees because it only matches `queued`, ended
        // up with no activity row, no notification and no marker. The two
        // strings are truncated above so the common cause cannot happen at all;
        // this catches the rest (a transient error on either insert).
        await announceSendFailure(db, organisationId, after, lastError).catch((notifyErr: unknown) => {
          console.error(
            { organisationId, messageId: v.messageId, error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr) },
            "message.send_failed announcement failed; the message is still recorded as failed",
          );
        });
      }
      return after;
    }
    throw err;
  }
}
