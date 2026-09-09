import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { createSite } from "../sites/create-site.js";
import { createDomain } from "../domains/domains.js";
import { createTicket } from "../support/create-ticket.js";
import { createTask } from "../tasks/create-task.js";
import { searchPortal } from "./search-portal.js";

/**
 * The portal's search is a different function from the admin's for one reason,
 * and every test here is about that reason: `search()` is scoped to an
 * organisation, and an organisation holds every client. Pointing the portal at
 * it would have shown one client another client's websites, domains and
 * support requests by typing three letters.
 *
 * So the first test is the security one, and the rest are the visibility rules
 * the portal's own screens already apply — a client must not find by search
 * what they cannot reach by clicking.
 */

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("searchPortal", () => {
  it("never returns another client's records, even in the same organisation", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const token = crypto.randomUUID().slice(0, 8);

      const mine = await createClient(db, org.id, { name: `Mine ${token}` });
      const theirs = await createClient(db, org.id, { name: `Theirs ${token}` });

      // Both match the same term, so only the scoping can keep them apart.
      const mySite = await createSite(db, org.id, { clientId: mine.id, name: `mine site-${token}`, primaryUrl: `https://mine-${token}.test` });
      const theirSite = await createSite(db, org.id, { clientId: theirs.id, name: `theirs site-${token}`, primaryUrl: `https://theirs-${token}.test` });
      await createDomain(db, org.id, { clientId: mine.id, name: `mine-${token}.test`, siteId: mySite.id });
      await createDomain(db, org.id, { clientId: theirs.id, name: `theirs-${token}.test`, siteId: theirSite.id });
      await createTicket(db, org.id, { clientId: mine.id, subject: `Broken ${token}`, body: "b", source: "portal" });
      await createTicket(db, org.id, { clientId: theirs.id, subject: `Broken ${token}`, body: "b", source: "portal" });
      await createTask(db, org.id, { clientId: mine.id, title: `Fix ${token}`, phase: "support" });
      await createTask(db, org.id, { clientId: theirs.id, title: `Fix ${token}`, phase: "support" });

      const hits = await searchPortal(db, org.id, mine.id, { q: token });

      expect(hits.sites).toHaveLength(1);
      expect(hits.sites[0]!.id).toBe(mySite.id);
      expect(hits.domains).toHaveLength(1);
      expect(hits.domains[0]!.name).toBe(`mine-${token}.test`);
      expect(hits.requests).toHaveLength(1);
      expect(hits.tasks).toHaveLength(1);

      // Nothing anywhere in the result carries the other client's id.
      const everything = JSON.stringify(hits);
      expect(everything).not.toContain(theirs.id);
      expect(everything).not.toContain(`theirs-${token}`);
    });
  });

  it("refuses a client from another organisation outright", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const token = crypto.randomUUID().slice(0, 8);

      const client = await createClient(db, orgA.id, { name: `Cabline ${token}` });
      await createSite(db, orgA.id, { clientId: client.id, name: `site-${token}`, primaryUrl: `https://${token}.test` });

      // The client id is real, the organisation is not theirs. Both filters
      // apply, so this finds nothing rather than leaking across the tenant.
      const hits = await searchPortal(db, orgB.id, client.id, { q: token });
      expect(hits).toEqual({ sites: [], domains: [], requests: [], tasks: [], invoices: [], documents: [] });
    });
  });

  it("hides a support request that is not client-visible", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const token = crypto.randomUUID().slice(0, 8);
      const client = await createClient(db, org.id, { name: `Cabline ${token}` });

      // The overdue sweep opens one of these per unpaid invoice, and an agent's
      // `tickets_create` is internal by design. Theirs by client_id; not theirs
      // to read.
      const { ticket } = await createTicket(db, org.id, { clientId: client.id, subject: `Chase ${token}`, body: "b", source: "portal" });
      await db.update(schema.tickets).set({ clientVisible: false }).where(eq(schema.tickets.id, ticket.id));

      const hits = await searchPortal(db, org.id, client.id, { q: token });
      expect(hits.requests).toHaveLength(0);
    });
  });

  it("hides an internal task", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const token = crypto.randomUUID().slice(0, 8);
      const client = await createClient(db, org.id, { name: `Cabline ${token}` });

      const task = await createTask(db, org.id, { clientId: client.id, title: `Fix ${token}`, phase: "support" });
      await db.update(schema.tasks).set({ clientVisible: false }).where(eq(schema.tasks.id, task.id));

      const hits = await searchPortal(db, org.id, client.id, { q: token });
      expect(hits.tasks).toHaveLength(0);
    });
  });

  it("hides a draft invoice, the way the invoices screen does", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const token = crypto.randomUUID().slice(0, 8);
      const client = await createClient(db, org.id, { name: `Cabline ${token}` });

      await db.insert(schema.invoices).values([
        { organisationId: org.id, clientId: client.id, number: `DRAFT-${token}`, status: "draft", subtotalPence: 1000, totalPence: 1000, dueAt: new Date() },
        { organisationId: org.id, clientId: client.id, number: `SENT-${token}`, status: "sent", subtotalPence: 1000, totalPence: 1000, dueAt: new Date() },
      ]);

      const hits = await searchPortal(db, org.id, client.id, { q: token });
      expect(hits.invoices.map((row) => row.number)).toEqual([`SENT-${token}`]);
    });
  });

  it("treats % as a literal, not a wildcard", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Cabline" });
      await createSite(db, org.id, { clientId: client.id, name: "plain", primaryUrl: "https://plain.test" });

      // Were the term interpolated raw, "%" would match every row this client
      // owns and the search would look like it worked.
      const hits = await searchPortal(db, org.id, client.id, { q: "%" });
      expect(hits.sites).toHaveLength(0);
    });
  });
});

