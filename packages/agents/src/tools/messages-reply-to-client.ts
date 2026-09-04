import { replyToConversation } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The app's own base URL, so a portal reply's courtesy email can say where to
 * sign in. Read from the environment — the worker validates `APP_URL` at
 * startup (`apps/worker/src/env.ts`) — rather than from the tool input, because
 * where a client is told to log in is not a decision a model gets to make. An
 * unset or malformed value is simply no link: `portalUrl` is optional.
 */
function portalUrl(): string | undefined {
  const raw = process.env["APP_URL"];
  if (!raw) return undefined;
  try {
    return new URL(raw).toString();
  } catch {
    return undefined;
  }
}

export const messagesReplyToClient = defineTool({
  name: "messages_reply_to_client",
  description: "Send a reply to the client on this conversation. A human must approve it before it leaves the building.",
  input: z.object({
    conversationId: z.string().uuid(),
    body: z.string().min(1).max(8000).describe("Plain text. British English, warm and specific. No markdown headings."),
  }),
  risk: "requires_approval",
  // The thread's client and subject come from our rows; only the drafted body
  // is the model's, and that is precisely the text the approver must read.
  describeApproval: async (input, ctx) => {
    const [thread] = await ctx.db
      .select({
        subject: schema.conversations.subject,
        channel: schema.conversations.channel,
        clientName: schema.clients.name,
        participantEmail: schema.conversations.participantEmail,
      })
      .from(schema.conversations)
      .innerJoin(schema.clients, eq(schema.conversations.clientId, schema.clients.id))
      .where(
        and(
          eq(schema.conversations.id, input.conversationId),
          eq(schema.conversations.organisationId, ctx.organisationId),
        ),
      );
    if (!thread) {
      return {
        title: "Reply on a conversation that does not exist",
        summary: `No conversation ${input.conversationId} exists in this organisation. Approving it will fail.`,
        details: { draftedReply: input.body },
      };
    }
    // What approving actually does differs by thread, and the card is the last
    // gate before this leaves the building, so it has to say which. An email
    // thread is queued and a worker sends it; a portal thread has no outbox at
    // all — writing the row is the delivery, and the client can read it the
    // moment the approval is released.
    const byEmail = thread.channel === "email";
    const broken = byEmail && !thread.participantEmail;
    return {
      title: `Reply to ${thread.clientName} on "${thread.subject}"`,
      summary: broken
        ? `The email thread "${thread.subject}" has no address to reply to, so approving this will fail.` +
          ` Answer ${thread.clientName} on the case instead.`
        : byEmail
          ? `Approving queues this reply to ${thread.clientName} on the email thread "${thread.subject}"` +
            ` (${thread.participantEmail}). The worker sends it from the outbox.`
          : `Approving posts this reply to ${thread.clientName} on the ${thread.channel} thread "${thread.subject}".` +
            ` It is delivered in the portal immediately — there is no outbox to catch it — and the case moves to` +
            ` waiting on the client.`,
      details: {
        client: thread.clientName,
        subject: thread.subject,
        channel: thread.channel,
        delivery: broken
          ? "nowhere — this thread has no address"
          : byEmail
            ? `emailed to ${thread.participantEmail}`
            : "delivered in the portal",
        draftedReply: input.body,
      },
    };
  },
  execute: async (input, ctx) => {
    // A portal reply queues a courtesy email; without this it tells the client
    // to sign in without saying where.
    const base = portalUrl();
    const message = await replyToConversation(ctx.db, ctx.organisationId, {
      conversationId: input.conversationId, body: input.body, actorKind: "agent", actorId: "support-triage",
      ...(base ? { portalUrl: base } : {}),
    });
    return { messageId: message.id, status: message.status };
  },
});
