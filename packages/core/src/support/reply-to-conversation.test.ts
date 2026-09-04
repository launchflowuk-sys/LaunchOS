import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { ensureEmailIdentity } from "../email/ensure-email-identity.js";
import { ingestInboundEmail } from "./ingest-inbound-email.js";
import { replyToConversation } from "./reply-to-conversation.js";
import { sendQueuedMessage } from "./send-queued-message.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "LaunchFlow <support@launchflow.test>" };

describe("replyToConversation + sendQueuedMessage", () => {
  it("queues an outbound reply, stamps first_response_at, then sends it via the adapter", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
      const ingested = await ingestInboundEmail(db, org!.id, {
        provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Site is down", text: "503",
        messageId: "<in-1@client.test>", references: [], attachments: [], rawHeaders: {},
      });

      const queued = await replyToConversation(db, org!.id, {
        conversationId: ingested.conversation.id, body: "We have restarted the container.", actorKind: "user", actorId: "u1",
      });
      expect(queued.direction).toBe("outbound");
      expect(queued.status).toBe("queued");
      expect(queued.toEmail).toBe("jo@client.test");
      expect(queued.fromEmail).toBe(identity.address);
      expect(queued.subject).toBe("Re: Site is down");

      const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ingested.ticket.id));
      expect(ticket!.firstResponseAt).toBeInstanceOf(Date);

      const adapter = new MockEmailAdapter();
      const sent = await sendQueuedMessage(db, org!.id, { messageId: queued.id }, adapter, ENV);
      expect(sent.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]!.inReplyTo).toBe("<in-1@client.test>");
      expect(adapter.sent[0]!.replyTo).toBe(identity.address);

      // A retried job must not send twice.
      await sendQueuedMessage(db, org!.id, { messageId: queued.id }, adapter, ENV);
      expect(adapter.sent).toHaveLength(1);
    });
  });

  it("records an internal note with no email status and does not queue a send", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const [conversation] = await db.insert(schema.conversations).values({
        organisationId: org!.id, clientId: client!.id, subject: "S", channel: "email", participantEmail: "jo@client.test",
      }).returning();

      const note = await replyToConversation(db, org!.id, {
        conversationId: conversation!.id, body: "Chased hosting.", actorKind: "user", actorId: "u1", internal: true,
      });
      expect(note.direction).toBe("internal");
      expect(note.status).toBeNull();
    });
  });
});
