import { replyToConversation } from "@launchos/core";
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
  execute: async (input, ctx) => {
    const message = await replyToConversation(ctx.db, ctx.organisationId, {
      conversationId: input.conversationId, body: input.body, actorKind: "agent", actorId: "support-triage",
    });
    return { messageId: message.id, status: message.status };
  },
});
