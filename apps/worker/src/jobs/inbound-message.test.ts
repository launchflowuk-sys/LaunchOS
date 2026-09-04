import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { ensureEmailIdentity } from "@launchos/core";
import { handleInboundMessage } from "./inbound-message.js";

describe("handleInboundMessage", () => {
  it("ingests the queued payload into a conversation, message and ticket", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, { SUPPORT_EMAIL_DOMAIN: "support.test" });

      const result = await handleInboundMessage({ db, logger: console }, {
        organisationId: org!.id,
        inbound: {
          provider: "generic", to: [identity.address], from: "jo@client.test", subject: "Help", text: "Broken",
          messageId: "<w-1@client.test>", references: [], attachments: [], rawHeaders: {},
        },
      });

      expect(result.matched).toBe(true);
      expect(result.ticket.source).toBe("email");
    });
  });
});
