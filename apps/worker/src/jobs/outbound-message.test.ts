import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { MockEmailAdapter } from "@launchos/channels";
import { ensureEmailIdentity, ingestInboundEmail, replyToConversation } from "@launchos/core";
import { handleOutboundMessage } from "./outbound-message.js";

describe("handleOutboundMessage", () => {
  it("sends a queued message through the adapter and marks it sent", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, { SUPPORT_EMAIL_DOMAIN: "support.test" });
      const ingested = await ingestInboundEmail(db, org!.id, {
        provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Help", text: "Broken",
        messageId: "<w-2@client.test>", references: [], attachments: [], rawHeaders: {},
      });
      const queued = await replyToConversation(db, org!.id, { conversationId: ingested.conversation.id, body: "On it.", actorKind: "user", actorId: "u1" });

      const adapter = new MockEmailAdapter();
      const sent = await handleOutboundMessage({ db, adapter, logger: console }, { organisationId: org!.id, messageId: queued.id });

      expect(sent.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
    });
  });
});
