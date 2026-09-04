import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const SendQueuedMessageInput = z.object({ messageId: z.string().uuid() });
export type SendQueuedMessageInput = z.input<typeof SendQueuedMessageInput>;

async function patchMessage(db: Db, organisationId: string, messageId: string, patch: Record<string, unknown>) {
  const [row] = await db
    .update(schema.messages)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.organisationId, organisationId)))
    .returning();
  return row!;
}

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
  // A pg-boss retry of an already-sent job must not send twice.
  if (message.status !== "queued") return message;
  if (!message.toEmail || !message.fromEmail) throw new Error(`message ${v.messageId} is not addressable`);

  const inReplyTo = message.rawHeaders["in-reply-to"];
  try {
    const result = await adapter.send({
      to: message.toEmail,
      // The envelope sender is the verified MAIL_FROM; the client's own support
      // address is the Reply-To so their answer threads back to them.
      from: env.MAIL_FROM ?? message.fromEmail,
      replyTo: message.fromEmail,
      subject: message.subject ?? "(no subject)",
      text: message.body,
      inReplyTo,
      references: inReplyTo ? [inReplyTo] : undefined,
    });
    const sent = await patchMessage(db, organisationId, v.messageId, {
      status: "sent", deliveredAt: new Date(), externalId: result.providerMessageId,
    });
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "message.sent", targetType: "message", targetId: v.messageId, before: message, after: sent,
    });
    return sent;
  } catch (err) {
    await patchMessage(db, organisationId, v.messageId, { status: "failed" });
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "message.send_failed", targetType: "message", targetId: v.messageId,
      after: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err; // let pg-boss retry
  }
}
