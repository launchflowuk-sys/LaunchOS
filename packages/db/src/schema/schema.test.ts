import type { Db } from "@launchos/db";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTestDb } from "../test/db.js";
import { organisations, clients, sites, monitors, incidents, tickets, agentRuns, billingProfiles, activityEvents, notifications, domains, user } from "./index.js";
import * as schema from "./index.js";

describe("schema", () => {
  it("inserts an organisation → client → site → monitor → incident chain", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "LaunchFlow", slug: `test-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "Grays CabLine", slug: "grays-cabline" }).returning();
      const [site] = await db.insert(sites).values({ organisationId: org!.id, clientId: client!.id, name: "grayscabline.co.uk", primaryUrl: "https://grayscabline.co.uk" }).returning();
      const [monitor] = await db.insert(monitors).values({ organisationId: org!.id, siteId: site!.id, kind: "http", target: "https://grayscabline.co.uk" }).returning();
      const [incident] = await db.insert(incidents).values({ organisationId: org!.id, siteId: site!.id, monitorId: monitor!.id, severity: "high", title: "Site down" }).returning();
      expect(incident!.status).toBe("open");
      const [run] = await db.insert(agentRuns).values({ organisationId: org!.id, agentKey: "hosting-guard-dog", trigger: "event", input: {} }).returning();
      expect(run!.status).toBe("running");
      const [ticket] = await db.insert(tickets).values({ organisationId: org!.id, clientId: client!.id, siteId: site!.id, subject: "Site down", severity: "high", source: "monitor" }).returning();
      expect(ticket!.status).toBe("open");
    });
  });
});

async function seedUserId(db: Db): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "Member", email: `member-${id}@example.test`, emailVerified: true });
  return id;
}

describe("plan 2 schema", () => {
  it("stores a client with a slug and support email, its billing profile, a client-less domain and a timeline event", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "LaunchFlow", slug: `p2-${crypto.randomUUID()}` }).returning();
      const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;
      const [client] = await db.insert(clients).values({
        organisationId: org!.id, name: "Acme", slug, supportEmail: `${slug}@support.launchflow.test`,
        addressLine1: "1 High Street", city: "Grays", postcode: "RM17 6AA", websiteUrl: "https://acme.test", industry: "Retail",
      }).returning();
      expect(client!.country).toBe("GB");
      expect(client!.packageId).toBeNull();

      const [billing] = await db.insert(billingProfiles).values({ organisationId: org!.id, clientId: client!.id, billingName: "Acme Ltd" }).returning();
      expect(billing!.paymentTermsDays).toBe(14);

      const [domain] = await db.insert(domains).values({
        organisationId: org!.id, clientId: client!.id, name: `${slug}.test`, dnsProvider: "cloudflare", nameservers: ["ns1.test", "ns2.test"],
      }).returning();
      expect(domain!.siteId).toBeNull();
      expect(domain!.nameservers).toEqual(["ns1.test", "ns2.test"]);

      const [event] = await db.insert(activityEvents).values({
        organisationId: org!.id, clientId: client!.id, actorKind: "system", kind: "client.created", title: "Client created",
      }).returning();
      expect(event!.title).toBe("Client created");
      expect(event!.link).toBeNull();

      const [notification] = await db.insert(notifications).values({
        organisationId: org!.id, userId: await seedUserId(db), kind: "client.created", title: "New client",
      }).returning();
      expect(notification!.readAt).toBeNull();
    });
  });
});

describe("plan 4 schema", () => {
  it("stores an email identity, a knowledge article and P4 support columns", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();

      const [identity] = await db.insert(schema.emailIdentities).values({
        organisationId: org!.id, clientId: client!.id, address: `c-${crypto.randomUUID()}@support.test`, inboundSecret: "s",
      }).returning();
      expect(identity!.address).toContain("@support.test");

      const [article] = await db.insert(schema.knowledgeArticles).values({
        organisationId: org!.id, title: "DNS propagation", slug: `dns-${crypto.randomUUID()}`,
        bodyMd: "Nameserver changes take up to 48 hours to propagate.", tags: ["dns"], published: true,
      }).returning();
      const hits = await db.execute(sql`
        select id from knowledge_articles
        where organisation_id = ${org!.id} and search @@ plainto_tsquery('english', 'propagate nameserver')
      `);
      expect(hits.map((r) => r.id)).toContain(article!.id);

      const [conversation] = await db.insert(schema.conversations).values({
        organisationId: org!.id, clientId: client!.id, subject: "Help", channel: "email",
        externalThreadKey: "<a@b.test>", participantEmail: "sender@b.test",
      }).returning();
      const [message] = await db.insert(schema.messages).values({
        organisationId: org!.id, conversationId: conversation!.id, direction: "inbound", authorKind: "client",
        body: "hello", fromEmail: "sender@b.test", toEmail: identity!.address, subject: "Help",
        rawHeaders: { "message-id": "<a@b.test>" }, attachments: [], status: "received",
      }).returning();
      expect(message!.status).toBe("received");

      const [ticket] = await db.insert(schema.tickets).values({
        organisationId: org!.id, conversationId: conversation!.id, clientId: client!.id, subject: "Help",
        source: "email", slaDueAt: new Date(), triage: { category: "dns", severity: "high", summary: "s", suggestedFix: "f", confidence: 0.8 },
      }).returning();
      expect(ticket!.triage).toMatchObject({ category: "dns" });
    });
  });
});
