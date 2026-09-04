import { replyToConversation } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

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
    return {
      title: `Reply to ${thread.clientName} on "${thread.subject}"`,
      summary:
        `Approving queues this reply to ${thread.clientName} on the ${thread.channel} thread "${thread.subject}"` +
        `${thread.participantEmail ? ` (${thread.participantEmail})` : ""}. The worker sends it from the outbox.`,
      details: {
        client: thread.clientName,
        subject: thread.subject,
        channel: thread.channel,
        draftedReply: input.body,
      },
    };
  },
  execute: async (input, ctx) => {
    const message = await replyToConversation(ctx.db, ctx.organisationId, {
      conversationId: input.conversationId, body: input.body, actorKind: "agent", actorId: "support-triage",
    });
    return { messageId: message.id, status: message.status };
  },
});
