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

  /**
   * A domain outlives the client row it was first filed under. One was added
   * by hand before the Stripe import existed, the client it landed on was
   * archived, and the name was then unusable: archiving does not release it,
   * `updateDomain` could not change its owner, and the unique index on
   * (organisation, name) refuses a second row. Three missing doors, one stuck
   * domain.
   */
  it("moves a domain to another client, keeping its DNS records", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const from = await createClient(db, org.id, { name: "Wrong client" });
      const to = await createClient(db, org.id, { name: "Right client" });
      const name = `move-${crypto.randomUUID().slice(0, 8)}.test`;

      const domain = await createDomain(db, org.id, { clientId: from.id, name, actorKind: "user", actorId: "u1" });
      await createDnsRecord(db, org.id, {
        domainId: domain.id, type: "A", name: "@", value: "203.0.113.1", actorKind: "user", actorId: "u1",
      });

      const moved = await updateDomain(db, org.id, { domainId: domain.id, clientId: to.id, actorKind: "user", actorId: "u1" });

      expect(moved.clientId).toBe(to.id);
      expect(await listDomains(db, org.id, { clientId: to.id })).toHaveLength(1);
      expect(await listDomains(db, org.id, { clientId: from.id })).toHaveLength(0);
      // The records belong to the domain, not to whoever owns it this week.
      expect(await listDnsRecords(db, org.id, domain.id)).toHaveLength(1);
    });
  });

  it("refuses to move a domain to a client in another organisation", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const other = await makeOrg(db);
      const mine = await createClient(db, org.id, { name: "Mine" });
      const theirs = await createClient(db, other.id, { name: "Theirs" });
      const name = `tenancy-${crypto.randomUUID().slice(0, 8)}.test`;

      const domain = await createDomain(db, org.id, { clientId: mine.id, name, actorKind: "user", actorId: "u1" });

      await expect(
        updateDomain(db, org.id, { domainId: domain.id, clientId: theirs.id, actorKind: "user", actorId: "u1" }),
      ).rejects.toThrow();
    });
  });

  it("frees the name once the domain is deleted, so it can be added again", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });
      const name = `reuse-${crypto.randomUUID().slice(0, 8)}.test`;

      const first = await createDomain(db, org.id, { clientId: client.id, name, actorKind: "user", actorId: "u1" });
      await expect(
        createDomain(db, org.id, { clientId: client.id, name, actorKind: "user", actorId: "u1" }),
      ).rejects.toThrow();

      await deleteDomain(db, org.id, { domainId: first.id, actorKind: "user", actorId: "u1" });

      const second = await createDomain(db, org.id, { clientId: client.id, name, actorKind: "user", actorId: "u1" });
      expect(second.name).toBe(name);
    });
  });

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
