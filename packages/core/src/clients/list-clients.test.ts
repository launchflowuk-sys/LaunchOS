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

  it("orders by name by default, so a client dropdown is alphabetical whatever the creation order", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const suffix = crypto.randomUUID().slice(0, 8);
      // `created_at` is the transaction timestamp, identical for every row this
      // test inserts, so the dates are set explicitly — and set so that creation
      // order is the reverse of the alphabet: a query still ordered by
      // `created_at` cannot pass this by luck.
      const [zed, mid, ace] = await db
        .insert(schema.clients)
        .values(
          [
            { name: `Zed ${suffix}`, slug: `zed-${suffix}`, createdAt: new Date(Date.UTC(2026, 0, 3)) },
            { name: `Mid ${suffix}`, slug: `mid-${suffix}`, createdAt: new Date(Date.UTC(2026, 0, 2)) },
            { name: `Ace ${suffix}`, slug: `ace-${suffix}`, createdAt: new Date(Date.UTC(2026, 0, 1)) },
          ].map((c) => ({ ...c, organisationId: org.id, status: "active" as const })),
        )
        .returning();

      const names = (rows: { name: string }[]) => rows.map((r) => r.name);

      // No `order` at all: the shape every dropdown call site uses.
      const all = await listClients(db, org.id, { query: suffix });
      expect(names(all)).toEqual([`Ace ${suffix}`, `Mid ${suffix}`, `Zed ${suffix}`]);
      expect(all.map((c) => c.id)).toEqual([ace!.id, mid!.id, zed!.id]);

      // Explicit "name" is the same order, and it pages without repeats.
      const first = await listClients(db, org.id, { query: suffix, order: "name", limit: 2 });
      expect(names(first)).toEqual([`Ace ${suffix}`, `Mid ${suffix}`]);
      const second = await listClients(db, org.id, { query: suffix, order: "name", limit: 2, offset: 2 });
      expect(names(second)).toEqual([`Zed ${suffix}`]);

      // Same rows, other order — the option is what moves them.
      const recent = await listClients(db, org.id, { query: suffix, order: "recent" });
      expect(names(recent)).toEqual([`Ace ${suffix}`, `Mid ${suffix}`, `Zed ${suffix}`].reverse());
    });
  });

  it("pages newest first when asked, with limit and offset, keeping the status and search filters", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      // `created_at` defaults to the transaction timestamp, which is the same
      // instant for every row inserted here, so the dates are set explicitly:
      // the point of the test is the order, not the clock.
      const at = (day: number) => new Date(Date.UTC(2026, 0, day));
      const suffix = crypto.randomUUID().slice(0, 8);
      await db.insert(schema.clients).values(
        [1, 2, 3, 4].map((n) => ({
          organisationId: org.id,
          name: `Paged ${n} ${suffix}`,
          slug: `paged-${n}-${suffix}`,
          status: "active" as const,
          createdAt: at(n),
        })),
      );
      // An archived row on the newest date: it must not take a slot on page 1
      // of an active-only listing.
      await db.insert(schema.clients).values({
        organisationId: org.id,
        name: `Paged 5 ${suffix}`,
        slug: `paged-5-${suffix}`,
        status: "archived",
        createdAt: at(9),
      });

      const names = (rows: { name: string }[]) => rows.map((r) => r.name);

      const first = await listClients(db, org.id, { status: "active", order: "recent", limit: 2, offset: 0 });
      expect(names(first)).toEqual([`Paged 4 ${suffix}`, `Paged 3 ${suffix}`]);

      const second = await listClients(db, org.id, { status: "active", order: "recent", limit: 2, offset: 2 });
      expect(names(second)).toEqual([`Paged 2 ${suffix}`, `Paged 1 ${suffix}`]);

      // Past the end is empty, not a repeat of the last page.
      expect(await listClients(db, org.id, { status: "active", order: "recent", limit: 2, offset: 4 })).toHaveLength(0);

      // The search term survives the offset, and the archived row is excluded
      // by status even though it matches the term and is the newest.
      const searched = await listClients(db, org.id, { query: `Paged`, status: "active", order: "recent", limit: 3, offset: 1 });
      expect(names(searched)).toEqual([`Paged 3 ${suffix}`, `Paged 2 ${suffix}`, `Paged 1 ${suffix}`]);

      // Without a status filter the archived row is the newest of the five.
      const all = await listClients(db, org.id, { query: suffix, order: "recent", limit: 1 });
      expect(names(all)).toEqual([`Paged 5 ${suffix}`]);
    });
  });
});
