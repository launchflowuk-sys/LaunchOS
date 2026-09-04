import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq, sql } from "drizzle-orm";
import { MockEmailAdapter, type EmailAdapter, type SendResult } from "@launchos/channels";
import { ensureEmailIdentity } from "../email/ensure-email-identity.js";
import { ingestInboundEmail } from "./ingest-inbound-email.js";
import { replyToConversation } from "./reply-to-conversation.js";
import { MAX_SEND_ATTEMPTS, sendQueuedMessage } from "./send-queued-message.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "LaunchFlow <support@launchflow.test>" };

/** Stands in for an SMTP server that is refusing connections. */
class FailingEmailAdapter implements EmailAdapter {
  readonly name = "mock" as const;
  calls = 0;
  async send(): Promise<SendResult> {
    this.calls += 1;
    throw new Error("smtp connection refused");
  }
}

async function seedThread(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
  const ingested = await ingestInboundEmail(db, org!.id, {
    provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Site is down", text: "503",
    messageId: `<in-${crypto.randomUUID()}@client.test>`, references: [], attachments: [], rawHeaders: {},
  });
  return { organisationId: org!.id, identity, ingested };
}

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

  // The portal itself goes through `replyAsClient` now; this is the backstop
  // for any other caller that hands this function `actorKind: "client"`.
  it("keeps a client's own reply inside the thread even when internal is false", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ingested } = await seedThread(db);

      const reply = await replyToConversation(db, organisationId, {
        conversationId: ingested.conversation.id, body: "Still broken.",
        actorKind: "client", actorId: "jo@client.test", internal: false,
      });

      expect(reply.direction).toBe("internal");
      expect(reply.status).toBeNull();
      expect(reply.toEmail).toBeNull();

      // A client writing is not the agency's first response.
      const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ingested.ticket.id));
      expect(ticket!.firstResponseAt).toBeNull();
    });
  });

  it("keeps a failed send retryable, counting attempts, and rethrows for pg-boss", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ingested } = await seedThread(db);
      const queued = await replyToConversation(db, organisationId, {
        conversationId: ingested.conversation.id, body: "On it.", actorKind: "user", actorId: "u1",
      });
      const adapter = new FailingEmailAdapter();

      await expect(sendQueuedMessage(db, organisationId, { messageId: queued.id }, adapter, ENV)).rejects.toThrow(/connection refused/);

      const [after] = await db.select().from(schema.messages).where(eq(schema.messages.id, queued.id));
      expect(after!.status).toBe("queued");
      expect(after!.metadata["attempts"]).toBe(1);
      expect(after!.metadata["lastError"]).toContain("connection refused");
      // The claim is released, so the next attempt can take it.
      expect(after!.metadata["claimedAt"]).toBeUndefined();

      await expect(sendQueuedMessage(db, organisationId, { messageId: queued.id }, adapter, ENV)).rejects.toThrow();
      const [twice] = await db.select().from(schema.messages).where(eq(schema.messages.id, queued.id));
      expect(twice!.metadata["attempts"]).toBe(2);
      expect(adapter.calls).toBe(2);
    });
  });

  it("gives up after the attempt ceiling, marking the message failed without rethrowing", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ingested } = await seedThread(db);
      const queued = await replyToConversation(db, organisationId, {
        conversationId: ingested.conversation.id, body: "On it.", actorKind: "user", actorId: "u1",
      });
      await db.update(schema.messages)
        .set({ metadata: { attempts: MAX_SEND_ATTEMPTS - 1 } })
        .where(eq(schema.messages.id, queued.id));

      const adapter = new FailingEmailAdapter();
      const given = await sendQueuedMessage(db, organisationId, { messageId: queued.id }, adapter, ENV);

      expect(given.status).toBe("failed");
      expect(given.metadata["attempts"]).toBe(MAX_SEND_ATTEMPTS);
      // A failed message is terminal: a later job finds nothing to claim.
      const again = await sendQueuedMessage(db, organisationId, { messageId: queued.id }, adapter, ENV);
      expect(again.status).toBe("failed");
      expect(adapter.calls).toBe(1);
    });
  });

  it("does not send a message another worker is already holding", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ingested } = await seedThread(db);
      const queued = await replyToConversation(db, organisationId, {
        conversationId: ingested.conversation.id, body: "On it.", actorKind: "user", actorId: "u1",
      });
      // Another worker claimed it a moment ago and is still within the TTL.
      await db.update(schema.messages)
        .set({ metadata: sql`jsonb_build_object('claimedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MSZ'))` })
        .where(eq(schema.messages.id, queued.id));

      const adapter = new MockEmailAdapter();
      const result = await sendQueuedMessage(db, organisationId, { messageId: queued.id }, adapter, ENV);

      expect(adapter.sent).toHaveLength(0);
      expect(result.status).toBe("queued");
    });
  });
});
