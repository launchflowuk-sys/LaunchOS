import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { createSite } from "../sites/create-site.js";
import { createTicket } from "../support/create-ticket.js";
import { assertClientInOrganisation, assertOrgMember, assertOwned, assertSiteInOrganisation } from "./assert-owned.js";

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

describe("assertOwned", () => {
  it("names the table in its error and works for any tenant table", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db, "A");
      const orgB = await makeOrg(db, "B");
      const client = await createClient(db, orgA.id, { name: "A client" });
      const [domain] = await db
        .insert(schema.domains)
        .values({ organisationId: orgA.id, clientId: client.id, name: `${crypto.randomUUID()}.test` })
        .returning();

      await expect(assertOwned(db, orgA.id, schema.domains, domain!.id)).resolves.toBeUndefined();
      await expect(assertOwned(db, orgB.id, schema.domains, domain!.id)).rejects.toThrow(
        `domain ${domain!.id} not found in organisation`,
      );
      await expect(assertOwned(db, orgB.id, schema.clients, client.id)).rejects.toThrow(
        `client ${client.id} not found in organisation`,
      );
    });
  });

  it("assertClientInOrganisation and assertSiteInOrganisation stay thin wrappers over assertOwned", async () => {
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
});

describe("assertOrgMember", () => {
  it("accepts an active member and rejects a stranger or a suspended member", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db, "A");
      const activeId = crypto.randomUUID();
      const suspendedId = crypto.randomUUID();
      const [active] = await db
        .insert(schema.user)
        .values({ id: activeId, name: "Active", email: `active-${activeId}@example.test`, emailVerified: true })
        .returning();
      const [suspended] = await db
        .insert(schema.user)
        .values({ id: suspendedId, name: "Suspended", email: `suspended-${suspendedId}@example.test`, emailVerified: true })
        .returning();
      await db.insert(schema.organisationMembers).values({ organisationId: org.id, userId: active!.id, role: "staff" });
      await db
        .insert(schema.organisationMembers)
        .values({ organisationId: org.id, userId: suspended!.id, role: "staff", status: "suspended" });

      await expect(assertOrgMember(db, org.id, active!.id)).resolves.toBeUndefined();
      await expect(assertOrgMember(db, org.id, suspended!.id)).rejects.toThrow(
        `member ${suspended!.id} not found in organisation`,
      );
      await expect(assertOrgMember(db, org.id, "no-such-user")).rejects.toThrow(
        `member no-such-user not found in organisation`,
      );
    });
  });
});
