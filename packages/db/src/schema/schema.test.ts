import type { Db } from "@launchos/db";
import { describe, expect, it } from "vitest";
import { withTestDb } from "../test/db.js";
import { organisations, clients, sites, monitors, incidents, tickets, agentRuns, billingProfiles, activityEvents, notifications, domains, user } from "./index.js";

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
