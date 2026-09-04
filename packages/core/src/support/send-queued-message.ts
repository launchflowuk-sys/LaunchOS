import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";

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
 */
async function announceSendFailure(db: Db, organisationId: string, message: Message, lastError: string) {
  const [conversation] = await db
    .select({ clientId: schema.conversations.clientId })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, message.conversationId),
        eq(schema.conversations.organisationId, organisationId),
      ),
    );
  const to = message.toEmail ?? "the client";
  const link = `/inbox/${message.conversationId}`;
  const title = `A reply to ${to} was never sent`;
  const body = `${MAX_SEND_ATTEMPTS} send attempts failed and the message has been given up on. Last error: ${lastError}`;
  await recordActivity(db, organisationId, {
    ...(conversation ? { clientId: conversation.clientId } : {}),
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
  try {
    const result = await adapter.send({
      to: claimed.toEmail!,
      // The envelope sender is the verified MAIL_FROM; the client's own support
      // address is the Reply-To so their answer threads back to them.
      from: env.MAIL_FROM ?? claimed.fromEmail!,
      replyTo: claimed.fromEmail!,
      subject: claimed.subject ?? "(no subject)",
      text: claimed.body,
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
        await announceSendFailure(db, organisationId, after, lastError);
      }
      return after;
    }
    throw err;
  }
}
