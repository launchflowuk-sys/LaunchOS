import { PORTAL_REPLY_NOTICE_KIND, ensureEmailIdentity, ingestInboundEmail } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { describe, expect, it } from "vitest";
import { buildContext } from "../kernel/run-loop.js";
import { ticketsGet } from "./tickets-get.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test" };

describe("tickets_get thread", () => {
  it("leaves the courtesy notice out of the agent's context", async () => {
    await withTestDb(async (db) => {
      const [org] = await db
        .insert(schema.organisations)
        .values({ name: "T", slug: `t-${crypto.randomUUID()}` })
        .returning();
      const [client] = await db
        .insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` })
        .returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
      const ingested = await ingestInboundEmail(db, org!.id, {
        provider: "generic", to: [identity.address], from: "jo@client.test", subject: "DNS broken",
        text: "Will not resolve.", messageId: `<g-${crypto.randomUUID()}@client.test>`,
        references: [], attachments: [], rawHeaders: {},
      });
      const [run] = await db
        .insert(schema.agentRuns)
        .values({ organisationId: org!.id, agentKey: "support-triage", trigger: "event" })
        .returning();

      // The nudge a portal reply queues, as `replyToConversation` writes it.
      await db.insert(schema.messages).values({
        organisationId: org!.id,
        conversationId: ingested.conversation.id,
        direction: "outbound",
        authorKind: "system",
        body: "LaunchFlow has replied to your support case. Sign in to the portal to read it.",
        status: "queued",
        metadata: { kind: PORTAL_REPLY_NOTICE_KIND, round: 0 },
      });

      const out = await ticketsGet.execute(
        { ticketId: ingested.ticket.id },
        buildContext(db, org!.id, run!.id, console),
      );

      // The client's own words, and nothing the machine wrote to them.
      expect(out.messages).toHaveLength(1);
      expect(out.messages[0]!.body).toBe("Will not resolve.");
    });
  });
});
