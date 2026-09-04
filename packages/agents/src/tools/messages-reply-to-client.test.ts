import { createClient, createTicket, ensureEmailIdentity, ingestInboundEmail } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildContext } from "../kernel/run-loop.js";
import { messagesReplyToClient } from "./messages-reply-to-client.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test" };

async function organisation(db: Db) {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "T", slug: `t-${crypto.randomUUID()}` })
    .returning();
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ organisationId: org!.id, agentKey: "support-triage", trigger: "event" })
    .returning();
  return { organisationId: org!.id, ctx: buildContext(db, org!.id, run!.id, console) };
}

/**
 * The approval card is the last gate before a reply leaves the building, so
 * what it says about the effect of pressing approve has to be true — and the
 * effect is not the same on both kinds of thread.
 */
describe("messages_reply_to_client approval card", () => {
  it("says the email thread is queued for the outbox", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ctx } = await organisation(db);
      const [client] = await db
        .insert(schema.clients)
        .values({ organisationId, name: "C", slug: `c-${crypto.randomUUID()}` })
        .returning();
      const identity = await ensureEmailIdentity(db, organisationId, { clientId: client!.id }, ENV);
      const ingested = await ingestInboundEmail(db, organisationId, {
        provider: "generic", to: [identity.address], from: "jo@client.test", subject: "DNS broken",
        text: "Will not resolve.", messageId: `<a-${crypto.randomUUID()}@client.test>`,
        references: [], attachments: [], rawHeaders: {},
      });

      const card = await messagesReplyToClient.describeApproval!(
        { conversationId: ingested.conversation.id, body: "On it." },
        ctx,
      );
      expect(card.summary).toContain("jo@client.test");
      expect(card.summary).toContain("outbox");
      expect(card.details!["delivery"]).toBe("emailed to jo@client.test");
    });
  });

  it("says a portal thread reaches the client immediately, with no outbox", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ctx } = await organisation(db);
      const client = await createClient(db, organisationId, { name: "C" });
      const { conversation } = await createTicket(db, organisationId, {
        clientId: client.id, subject: "Contact form is down", body: "Nothing arrives.",
        severity: "medium", source: "portal", actorKind: "client", actorId: "portal-user-1",
      });

      const card = await messagesReplyToClient.describeApproval!(
        { conversationId: conversation.id, body: "Fixed." },
        ctx,
      );
      expect(card.summary).toContain("delivered in the portal immediately");
      // The promise the old copy made and this thread cannot keep.
      expect(card.summary).not.toMatch(/The worker sends it/);
      expect(card.details!["delivery"]).toBe("delivered in the portal");
      // The drafted text is still the thing the approver has to read.
      expect(card.details!["draftedReply"]).toBe("Fixed.");
    });
  });

  it("says a reply on a case the client cannot see will not be delivered at all", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ctx } = await organisation(db);
      const client = await createClient(db, organisationId, { name: "C" });
      // A case the agency raised: `internal` channel, `client_visible` false —
      // the shape "Run triage now" produces on a monitor-raised case.
      const { conversation } = await createTicket(db, organisationId, {
        clientId: client.id, subject: "Disk filling up", body: "92% on the web volume.",
        severity: "medium", source: "monitor", actorKind: "system",
      });

      const card = await messagesReplyToClient.describeApproval!(
        { conversationId: conversation.id, body: "We are on it." },
        ctx,
      );

      expect(card.summary).toContain("cannot be delivered");
      expect(card.summary).toContain("not client-visible");
      // No promise of a delivery that `execute` will refuse to make.
      expect(card.summary).not.toContain("delivered in the portal immediately");
      expect(card.details!["delivery"]).toBe("nowhere — this case is not client-visible");
      expect(card.details!["clientVisible"]).toBe(false);

      // And approving really would have failed.
      await expect(
        messagesReplyToClient.execute({ conversationId: conversation.id, body: "We are on it." }, ctx),
      ).rejects.toThrow(/visible to the client/);
    });
  });

  it("does not claim the case moves to waiting on the client when it will not", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ctx } = await organisation(db);
      const client = await createClient(db, organisationId, { name: "C" });
      const { ticket, conversation } = await createTicket(db, organisationId, {
        clientId: client.id, subject: "Contact form is down", body: "Nothing arrives.",
        severity: "medium", source: "portal", actorKind: "client", actorId: "portal-user-1",
      });
      await db.update(schema.tickets).set({ status: "resolved" }).where(eq(schema.tickets.id, ticket.id));

      const card = await messagesReplyToClient.describeApproval!(
        { conversationId: conversation.id, body: "One more thing." },
        ctx,
      );

      expect(card.summary).toContain("delivered in the portal immediately");
      expect(card.summary).not.toContain("waiting on the client");
    });
  });
});
