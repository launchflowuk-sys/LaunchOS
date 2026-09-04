import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createSite } from "../sites/create-site.js";
import { createDnsRecord, deleteDnsRecord, listDnsRecords, updateDnsRecord } from "./dns-records.js";
import { createDomain, deleteDomain, listDomains, updateDomain } from "./domains.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("domains", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => { events.length = 0; setEnqueue(async (e) => { events.push(e); }); });

  it("holds a domain with no site, attaches one later and carries DNS records", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });
      events.length = 0; // createClient also emits client.created; isolate the event under test
      const name = `acme-${crypto.randomUUID().slice(0, 8)}.test`;

      const domain = await createDomain(db, org.id, {
        clientId: client.id, name, registrar: "Namecheap", dnsProvider: "cloudflare",
        nameservers: ["ns1.cloudflare.test", "ns2.cloudflare.test"], actorKind: "user", actorId: "u1",
      });
      expect(domain.siteId).toBeNull();
      expect(domain.nameservers).toHaveLength(2);
      expect(events).toEqual([{ name: "domain.created", organisationId: org.id, domainId: domain.id }]);

      const site = await createSite(db, org.id, { clientId: client.id, name, primaryUrl: `https://${name}` });
      const attached = await updateDomain(db, org.id, { domainId: domain.id, siteId: site.id, notes: "Live" });
      expect(attached.siteId).toBe(site.id);

      const record = await createDnsRecord(db, org.id, { domainId: domain.id, type: "A", name: "@", value: "203.0.113.10" });
      await updateDnsRecord(db, org.id, { recordId: record.id, value: "203.0.113.11", ttl: 300 });
      const [saved] = await listDnsRecords(db, org.id, domain.id);
      expect(saved!.value).toBe("203.0.113.11");
      expect(saved!.ttl).toBe(300);

      const [listed] = await listDomains(db, org.id, { clientId: client.id });
      expect(listed!.clientName).toBe("Acme");
      expect(listed!.siteName).toBe(name);

      await deleteDnsRecord(db, org.id, { recordId: record.id });
      expect(await listDnsRecords(db, org.id, domain.id)).toHaveLength(0);
      await deleteDomain(db, org.id, { domainId: domain.id });
      expect(await listDomains(db, org.id, { clientId: client.id })).toHaveLength(0);
    });
  });

  it("refuses a duplicate name in the organisation and a site from another organisation", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const clientA = await createClient(db, orgA.id, { name: "Acme" });
      const clientB = await createClient(db, orgB.id, { name: "Other" });
      const siteB = await createSite(db, orgB.id, { clientId: clientB.id, name: "b", primaryUrl: "https://b.test" });
      const name = `dup-${crypto.randomUUID().slice(0, 8)}.test`;

      await createDomain(db, orgA.id, { clientId: clientA.id, name });
      await expect(createDomain(db, orgA.id, { clientId: clientA.id, name })).rejects.toThrow(`domain ${name} already exists`);
      await expect(createDomain(db, orgA.id, { clientId: clientA.id, name: `x-${name}`, siteId: siteB.id })).rejects.toThrow(
        `site ${siteB.id} not found in organisation`,
      );
    });
  });

  it("refuses to point a client's domain at another client's site, on both create and update", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const clientA = await createClient(db, org.id, { name: "Acme" });
      const clientB = await createClient(db, org.id, { name: "Other" });
      const nameA = `a-${crypto.randomUUID().slice(0, 8)}.test`;
      const nameB = `b-${crypto.randomUUID().slice(0, 8)}.test`;
      const siteB = await createSite(db, org.id, { clientId: clientB.id, name: nameB, primaryUrl: `https://${nameB}` });

      await expect(
        createDomain(db, org.id, { clientId: clientA.id, name: nameA, siteId: siteB.id }),
      ).rejects.toThrow(`site ${siteB.id} belongs to another client`);

      const domain = await createDomain(db, org.id, { clientId: clientA.id, name: nameA });
      await expect(
        updateDomain(db, org.id, { domainId: domain.id, siteId: siteB.id }),
      ).rejects.toThrow(`site ${siteB.id} belongs to another client`);
    });
  });

  it("rejects an A record whose value is not an IPv4 literal", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });
      const domain = await createDomain(db, org.id, { clientId: client.id, name: `bad-${crypto.randomUUID().slice(0, 8)}.test` });

      await expect(
        createDnsRecord(db, org.id, { domainId: domain.id, type: "A", name: "@", value: "not-an-ip" }),
      ).rejects.toThrow();
    });
  });
});
