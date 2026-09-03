import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { createSite } from "../sites/create-site.js";
import { createTicket } from "../support/create-ticket.js";
import { assertClientInOrganisation, assertSiteInOrganisation } from "./assert-owned.js";

async function makeOrg(db: Db, name: string) {
  const [org] = await db.insert(schema.organisations).values({ name, slug: `test-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("tenancy assertions", () => {
  it("accepts ids that belong to the organisation and rejects ones that do not", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db, "A");
      const orgB = await makeOrg(db, "B");
      const client = await createClient(db, orgA.id, { name: "A client" });
      const site = await createSite(db, orgA.id, { clientId: client.id, name: "S", primaryUrl: "https://a.test" });

      await expect(assertClientInOrganisation(db, orgA.id, client.id)).resolves.toBeUndefined();
      await expect(assertSiteInOrganisation(db, orgA.id, site.id)).resolves.toBeUndefined();
      await expect(assertClientInOrganisation(db, orgB.id, client.id)).rejects.toThrow(
        `client ${client.id} not found in organisation`,
      );
      await expect(assertSiteInOrganisation(db, orgB.id, site.id)).rejects.toThrow(
        `site ${site.id} not found in organisation`,
      );
    });
  });

  it("createTicket refuses another organisation's client and writes nothing", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db, "A");
      const orgB = await makeOrg(db, "B");
      const client = await createClient(db, orgA.id, { name: "A client" });

      await expect(
        createTicket(db, orgB.id, {
          clientId: client.id,
          subject: "Cross-tenant attempt",
          body: "should never be written",
          source: "agent",
        }),
      ).rejects.toThrow(`client ${client.id} not found in organisation`);

      const tickets = await db.select().from(schema.tickets).where(eq(schema.tickets.organisationId, orgB.id));
      const conversations = await db.select().from(schema.conversations).where(eq(schema.conversations.organisationId, orgB.id));
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, orgB.id));
      expect(tickets).toHaveLength(0);
      expect(conversations).toHaveLength(0);
      expect(messages).toHaveLength(0);
    });
  });

  it("createTicket refuses a site from another organisation", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db, "A");
      const orgB = await makeOrg(db, "B");
      const clientA = await createClient(db, orgA.id, { name: "A client" });
      const siteA = await createSite(db, orgA.id, { clientId: clientA.id, name: "S", primaryUrl: "https://a.test" });
      const clientB = await createClient(db, orgB.id, { name: "B client" });

      await expect(
        createTicket(db, orgB.id, {
          clientId: clientB.id,
          siteId: siteA.id,
          subject: "Cross-tenant site",
          body: "should never be written",
          source: "agent",
        }),
      ).rejects.toThrow(`site ${siteA.id} not found in organisation`);

      const tickets = await db.select().from(schema.tickets).where(eq(schema.tickets.organisationId, orgB.id));
      expect(tickets).toHaveLength(0);
    });
  });
});
