import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "./create-client.js";
import { getClient, listClients } from "./list-clients.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("listClients", () => {
  it("filters by status, matches name/slug/email case-insensitively and counts sites and domains", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const cab = await createClient(db, org.id, { name: "Grays CabLine", email: "info@grayscabline.co.uk" });
      const doc = await createClient(db, org.id, { name: "Mobile PC Doctor" });
      await db.insert(schema.clients).values({ organisationId: org.id, name: "Old Co", slug: "old-co", status: "archived" });

      const [site] = await db
        .insert(schema.sites)
        .values({ organisationId: org.id, clientId: cab.id, name: "cabline", primaryUrl: "https://cabline.test" })
        .returning();
      await db.insert(schema.domains).values([
        { organisationId: org.id, clientId: cab.id, siteId: site!.id, name: `a-${crypto.randomUUID()}.test` },
        { organisationId: org.id, clientId: cab.id, name: `b-${crypto.randomUUID()}.test` },
      ]);

      const active = await listClients(db, org.id, { status: "active" });
      expect(active.map((c) => c.id).sort()).toEqual([cab.id, doc.id].sort());

      const [match] = await listClients(db, org.id, { query: "GRAYSCABLINE.CO.UK" });
      expect(match!.id).toBe(cab.id);
      expect(match!.siteCount).toBe(1);
      expect(match!.domainCount).toBe(2);

      expect(await listClients(db, org.id, { query: "mobile-pc" })).toHaveLength(1);
      expect(await listClients(db, org.id, { status: "archived" })).toHaveLength(1);
      expect((await getClient(db, org.id, doc.id))?.name).toBe("Mobile PC Doctor");
    });
  });
});
