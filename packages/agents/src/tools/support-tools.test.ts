import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import {
  createDomain, createKnowledgeArticle, createSite, ensureEmailIdentity, ingestInboundEmail,
} from "@launchos/core";
import { MockCloudflareDns, MockCmsProvider } from "@launchos/integrations";
import { buildContext } from "../kernel/run-loop.js";
import { cmsUpdateContent } from "./cms-update-content.js";
import { dnsUpdateRecord } from "./dns-update-record.js";
import { knowledgeSearch } from "./knowledge-search.js";
import { messagesReplyToClient } from "./messages-reply-to-client.js";
import { tasksCreate } from "./tasks-create.js";
import { ticketsAssign } from "./tickets-assign.js";
import { ticketsEscalate } from "./tickets-escalate.js";
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

/** A real Better Auth user plus an active membership, for assignment/notification tests. */
async function addActiveMember(db: Db, organisationId: string, role: "owner" | "staff", displayName: string) {
  const userId = crypto.randomUUID();
  const [user] = await db.insert(schema.user)
    .values({ id: userId, name: displayName, email: `${displayName.toLowerCase()}-${userId}@example.test`, emailVerified: true })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId, userId: user!.id, role, status: "active", displayName });
  return user!.id;
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

  it("tasks_create derives the client and site from the ticket, not from the model", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const out = await tasksCreate.execute({ ticketId: f.ticket.id, title: "Repoint the NS records", kind: "dns", priority: "high" }, f.ctx);
      const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, out.taskId));
      expect(task!.clientId).toBe(f.ticket.clientId);
      expect(task!.siteId).toBe(f.ticket.siteId);
      expect(task!.ticketId).toBe(f.ticket.id);
      expect(task!.phase).toBe("support");
      expect(task!.clientVisible).toBe(false);
    });
  });

  it("tickets_assign gives the ticket to an active staff member and audits it", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const staffId = await addActiveMember(db, f.organisationId, "staff", "Staff");

      const out = await ticketsAssign.execute({ ticketId: f.ticket.id }, f.ctx);
      expect(out.assignedUserId).toBe(staffId);
      const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, f.ticket.id));
      expect(row!.assignedUserId).toBe(staffId);

      const [audit] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "ticket.assigned"), eq(schema.auditLog.targetId, f.ticket.id)));
      expect(audit).toBeDefined();
      expect(audit!.actorKind).toBe("agent");
      expect(audit!.actorId).toBe("support-triage");
    });
  });

  it("tickets_escalate marks the ticket escalated and notifies the owner", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const ownerId = await addActiveMember(db, f.organisationId, "owner", "Owner");

      const out = await ticketsEscalate.execute({ ticketId: f.ticket.id, reason: "Client is a VIP, no response in 2 hours" }, f.ctx);
      expect(out.escalated).toBe(true);
      const [row] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, f.ticket.id));
      expect(row!.escalated).toBe(true);
      expect(row!.escalationReason).toBe("Client is a VIP, no response in 2 hours");

      const [notification] = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ownerId), eq(schema.notifications.kind, "support.escalated")));
      expect(notification).toBeDefined();
    });
  });

  it("dns_update_record calls the provider with the org's own zone and audits the change", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const domain = await createDomain(db, f.organisationId, { clientId: f.ticket.clientId, name: `${crypto.randomUUID()}.co.uk` });
      const dns = new MockCloudflareDns();
      const tool = dnsUpdateRecord(dns);

      const out = await tool.execute({ domainId: domain.id, type: "A", name: "@", value: "203.0.113.10", ttl: 300 }, f.ctx);
      expect(out.applied).toBe(true);
      expect(dns.changes).toHaveLength(1);
      expect(dns.changes[0]).toMatchObject({ zone: domain.name, value: "203.0.113.10" });

      const [audit] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "dns_record.updated"), eq(schema.auditLog.targetId, out.dnsRecordId)));
      expect(audit).toBeDefined();
    });
  });

  it("cms_update_content calls the provider with the site's own hostingRef and audits the change", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const site = await createSite(db, f.organisationId, {
        clientId: f.ticket.clientId, name: "Client site", primaryUrl: "https://client.test", hostingRef: "app_1",
      });
      const cms = new MockCmsProvider();
      const tool = cmsUpdateContent(cms);

      const out = await tool.execute({ siteId: site.id, path: "/contact", contentMd: "New phone number." }, f.ctx);
      expect(out.applied).toBe(true);
      expect(cms.changes).toHaveLength(1);
      expect(cms.changes[0]).toMatchObject({ siteRef: "app_1", path: "/contact" });

      const [audit] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "site_content.updated"), eq(schema.auditLog.targetId, site.id)));
      expect(audit).toBeDefined();
    });
  });
});
