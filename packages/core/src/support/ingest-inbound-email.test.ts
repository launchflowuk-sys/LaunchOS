import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import type { InboundEmail } from "@launchos/channels";
import { ensureEmailIdentity } from "../email/ensure-email-identity.js";
import { HOLDING_CLIENT_SLUG, ingestInboundEmail } from "./ingest-inbound-email.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test" };

function inbound(over: Partial<InboundEmail> & Pick<InboundEmail, "to">): InboundEmail {
  return {
    provider: "generic", from: "jo@client.test", subject: "Site is down", text: "It shows a 503.",
    messageId: `<${crypto.randomUUID()}@client.test>`, references: [], attachments: [], rawHeaders: {}, ...over,
  };
}

async function newOrg(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return o!;
}

describe("ingestInboundEmail", () => {
  it("creates a conversation, message and ticket for a known support address", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const [client] = await db.insert(schema.clients).values({ organisationId: o.id, name: "Grays CabLine", slug: "grays-cabline" }).returning();
      const identity = await ensureEmailIdentity(db, o.id, { clientId: client!.id }, ENV);

      const result = await ingestInboundEmail(db, o.id, inbound({ to: [identity.address] }));

      expect(result.matched).toBe(true);
      expect(result.conversation.clientId).toBe(client!.id);
      expect(result.conversation.channel).toBe("email");
      expect(result.conversation.ticketId).toBe(result.ticket.id);
      expect(result.message.direction).toBe("inbound");
      expect(result.message.status).toBe("received");
      expect(result.ticket.source).toBe("email");
      expect(result.ticket.slaDueAt).toBeInstanceOf(Date);
    });
  });

  it("threads a reply onto the existing conversation and reuses its open ticket", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const [client] = await db.insert(schema.clients).values({ organisationId: o.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, o.id, { clientId: client!.id }, ENV);

      const first = await ingestInboundEmail(db, o.id, inbound({ to: [identity.address] }));
      const second = await ingestInboundEmail(db, o.id, inbound({
        to: [identity.address], inReplyTo: first.message.externalId!, references: [first.message.externalId!],
      }));

      expect(second.conversation.id).toBe(first.conversation.id);
      expect(second.ticket.id).toBe(first.ticket.id);
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, first.conversation.id));
      expect(messages).toHaveLength(2);
    });
  });

  it("files mail for an unknown address under the unmatched holding client", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      await db.insert(schema.clients).values({ organisationId: o.id, name: "Unmatched inbound", slug: HOLDING_CLIENT_SLUG });

      const result = await ingestInboundEmail(db, o.id, inbound({ to: ["nobody@support.test"] }));

      expect(result.matched).toBe(false);
      const [holding] = await db.select().from(schema.clients)
        .where(and(eq(schema.clients.organisationId, o.id), eq(schema.clients.slug, HOLDING_CLIENT_SLUG)));
      expect(result.conversation.clientId).toBe(holding!.id);
    });
  });

  it("creates the holding client on demand when the seed has not run", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);

      const result = await ingestInboundEmail(db, o.id, inbound({ to: ["nobody@support.test"] }));

      expect(result.matched).toBe(false);
      const [holding] = await db.select().from(schema.clients)
        .where(and(eq(schema.clients.organisationId, o.id), eq(schema.clients.slug, HOLDING_CLIENT_SLUG)));
      expect(holding).toBeDefined();
      expect(result.conversation.clientId).toBe(holding!.id);
    });
  });

  it("is idempotent for a redelivered provider payload", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const [client] = await db.insert(schema.clients).values({ organisationId: o.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, o.id, { clientId: client!.id }, ENV);
      const payload = inbound({ to: [identity.address] });

      const a = await ingestInboundEmail(db, o.id, payload);
      const b = await ingestInboundEmail(db, o.id, payload);

      expect(b.message.id).toBe(a.message.id);
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, a.conversation.id));
      expect(messages).toHaveLength(1);
    });
  });
});
