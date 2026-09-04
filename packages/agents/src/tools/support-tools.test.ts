import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createKnowledgeArticle, ensureEmailIdentity, ingestInboundEmail } from "@launchos/core";
import { MockCloudflareDns } from "@launchos/integrations";
import { buildContext } from "../kernel/run-loop.js";
import { dnsUpdateRecord } from "./dns-update-record.js";
import { knowledgeSearch } from "./knowledge-search.js";
import { messagesReplyToClient } from "./messages-reply-to-client.js";
import { ticketsGet } from "./tickets-get.js";
import { ticketsUpdate } from "./tickets-update.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test" };

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
  const ingested = await ingestInboundEmail(db, org!.id, {
    provider: "generic", to: [identity.address], from: "jo@client.test", subject: "DNS broken", text: "Site will not resolve.",
    messageId: "<t-1@client.test>", references: [], attachments: [], rawHeaders: {},
  });
  const [run] = await db.insert(schema.agentRuns).values({ organisationId: org!.id, agentKey: "support-triage", trigger: "event" }).returning();
  return { organisationId: org!.id, ticket: ingested.ticket, conversationId: ingested.conversation.id, ctx: buildContext(db, org!.id, run!.id, console) };
}

describe("support triage tools", () => {
  it("tickets_get returns the ticket, client and thread", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const out = await ticketsGet.execute({ ticketId: f.ticket.id }, f.ctx);
      expect(out.ticket.subject).toBe("DNS broken");
      expect(out.messages[0]!.body).toBe("Site will not resolve.");
      expect(out.messages[0]!.direction).toBe("inbound");
    });
  });

  it("knowledge_search returns ranked published hits", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await createKnowledgeArticle(db, f.organisationId, {
        title: "DNS propagation", bodyMd: "Nameserver changes take up to 48 hours.", tags: ["dns"], published: true,
      });
      const out = await knowledgeSearch.execute({ query: "nameserver dns", limit: 5 }, f.ctx);
      expect(out.hits[0]!.title).toBe("DNS propagation");
    });
  });

  it("tickets_update writes the triage json and is a safe tool", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      expect(ticketsUpdate.risk).toBe("safe");
      await ticketsUpdate.execute({
        ticketId: f.ticket.id, category: "dns", severity: "high", status: "triaged",
        triage: { category: "dns", severity: "high", summary: "NS not delegated", suggestedFix: "Repoint NS", confidence: 0.7 },
      }, f.ctx);
      const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, f.ticket.id));
      expect(row!.status).toBe("triaged");
      expect(row!.triage).toMatchObject({ summary: "NS not delegated" });
    });
  });

  it("messages_reply_to_client and dns_update_record require approval", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      expect(messagesReplyToClient.risk).toBe("requires_approval");
      expect(dnsUpdateRecord(new MockCloudflareDns()).risk).toBe("requires_approval");

      // Executed directly here, as resumeAgent does after a human approval.
      const out = await messagesReplyToClient.execute({ conversationId: f.conversationId, body: "We are on it." }, f.ctx);
      const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, out.messageId));
      expect(message!.direction).toBe("outbound");
      expect(message!.status).toBe("queued");
      expect(message!.authorKind).toBe("agent");
    });
  });
});
