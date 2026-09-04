import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { createSite } from "../sites/create-site.js";
import { createDomain } from "../domains/domains.js";
import { createTicket } from "../support/create-ticket.js";
import { search } from "./search.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("search", () => {
  it("matches clients, sites, domains and tickets in the organisation only", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const token = crypto.randomUUID().slice(0, 8);

      const client = await createClient(db, orgA.id, { name: `Cabline ${token}` });
      const site = await createSite(db, orgA.id, { clientId: client.id, name: `site-${token}`, primaryUrl: `https://${token}.test` });
      await createDomain(db, orgA.id, { clientId: client.id, name: `${token}.test`, siteId: site.id });
      await createTicket(db, orgA.id, { clientId: client.id, subject: `Broken ${token}`, body: "b", source: "manual" });

      const hits = await search(db, orgA.id, { q: token });
      expect(hits.clients).toHaveLength(1);
      expect(hits.sites).toHaveLength(1);
      expect(hits.domains).toHaveLength(1);
      expect(hits.tickets).toHaveLength(1);
      expect(hits.clients[0]!.slug).toBe(client.slug);

      const none = await search(db, orgB.id, { q: token });
      expect(none).toEqual({ clients: [], sites: [], domains: [], tickets: [] });
    });
  });

  it("treats % as a literal, not a wildcard", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await createClient(db, org.id, { name: "Acme" });
      expect((await search(db, org.id, { q: "%" })).clients).toHaveLength(0);
    });
  });
});
