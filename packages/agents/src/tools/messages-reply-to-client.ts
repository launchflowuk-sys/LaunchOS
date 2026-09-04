import { replyToConversation } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The default both hosts' env schemas apply when `APP_URL` is unset
 * (`apps/worker/src/env.ts`, `apps/web/src/lib/env.ts`). Repeated here so an
 * unset variable produces the same link the rest of the system believes in,
 * rather than a courtesy email that says "sign in to the portal" and gives
 * nowhere to sign in.
 *
 * **Outside production only.** This is the one link a *client* clicks, so a
 * loopback address here is not a harmless default — it points the reader at
 * their own machine. Both env schemas now refuse `APP_URL` unset or left on
 * this value under `NODE_ENV=production`, so in a correctly started process the
 * branch below is unreachable; it is kept because this tool reads
 * `process.env` directly rather than the parsed env, and a courtesy notice with
 * no link is strictly better than one with a wrong link.
 */
const APP_URL_DEFAULT = "http://localhost:3000";

/**
 * The app's own base URL, so a portal reply's courtesy email can say where to
 * sign in. Read from the environment rather than from the tool input, because
 * where a client is told to log in is not a decision a model gets to make.
 * A malformed value is no link at all — the notice still goes out.
 */
function portalUrl(): string | undefined {
  const configured = process.env["APP_URL"]?.trim();
  if (!configured && process.env["NODE_ENV"] === "production") {
    console.warn(
      "[messages_reply_to_client] APP_URL is not set: the courtesy notice goes out without a portal link rather than pointing the client at localhost.",
    );
    return undefined;
  }
  try {
    return new URL(configured || APP_URL_DEFAULT).toString();
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
        // Left-joined: a thread without a ticket is unusual but legal, and
        // core refuses only on a ticket that exists and is hidden.
        clientVisible: schema.tickets.clientVisible,
        ticketStatus: schema.tickets.status,
      })
      .from(schema.conversations)
      .innerJoin(schema.clients, eq(schema.conversations.clientId, schema.clients.id))
      .leftJoin(schema.tickets, eq(schema.conversations.ticketId, schema.tickets.id))
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
    // gate before this leaves the building, so it has to say which — including
    // when the answer is "nothing leaves". An email thread is queued and a
    // worker sends it; a portal thread has no outbox at all — writing the row
    // is the delivery. Neither happens on a case the client cannot open:
    // `replyToConversation` refuses a non-email reply on a hidden ticket, so
    // the card must say that rather than promise a portal delivery that throws.
    const byEmail = thread.channel === "email";
    const broken = byEmail && !thread.participantEmail;
    const hidden = !byEmail && thread.clientVisible === false;
    // The statuses a reply actually moves; anywhere else the case stays put, so
    // the card only claims the move when it is true.
    const willWait = thread.ticketStatus !== null
      && ["open", "triaged", "in_progress"].includes(thread.ticketStatus);
    return {
      title: `Reply to ${thread.clientName} on "${thread.subject}"`,
      summary: broken
        ? `The email thread "${thread.subject}" has no address to reply to, so approving this will fail.` +
          ` Answer ${thread.clientName} on the case instead.`
        : hidden
          ? `This reply cannot be delivered: the case "${thread.subject}" is not client-visible, so` +
            ` ${thread.clientName} cannot open it in the portal and there is no address to email.` +
            ` Approving will fail — share the case with the client on the case screen first.`
          : byEmail
            ? `Approving queues this reply to ${thread.clientName} on the email thread "${thread.subject}"` +
              ` (${thread.participantEmail}). The worker sends it from the outbox.`
            : `Approving posts this reply to ${thread.clientName} on the ${thread.channel} thread "${thread.subject}".` +
              ` It is delivered in the portal immediately — there is no outbox to catch it.` +
              (willWait ? ` The case then moves to waiting on the client.` : ``),
      details: {
        client: thread.clientName,
        subject: thread.subject,
        channel: thread.channel,
        clientVisible: thread.clientVisible ?? null,
        delivery: broken
          ? "nowhere — this thread has no address"
          : hidden
            ? "nowhere — this case is not client-visible"
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
