import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { listIncidents } from "./list-incidents.js";

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function addSite(db: Db, organisationId: string, clientId: string): Promise<string> {
  const [site] = await db
    .insert(schema.sites)
    .values({ organisationId, clientId, name: "grayscabline.co.uk", primaryUrl: "https://grayscabline.co.uk" })
    .returning();
  return site!.id;
}

describe("listIncidents", () => {
  it("carries the client and site names, so a reader never has to resolve an id", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const siteId = await addSite(db, organisationId, clientId);
      await db.insert(schema.incidents).values({ organisationId, siteId, title: "Site down", severity: "high" });

      // An incident read aloud as "site 4f2a…" is useless, and a second call
      // per row to turn ids into names is what makes an assistant slow.
      expect((await listIncidents(db, organisationId)).incidents[0]).toMatchObject({
        title: "Site down",
        clientName: "Grays CabLine",
        siteName: "grayscabline.co.uk",
        siteUrl: "https://grayscabline.co.uk",
      });
    });
  });

  it("says how long an open incident has been open, and nothing once resolved", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const siteId = await addSite(db, organisationId, clientId);
      await db.insert(schema.incidents).values({
        organisationId, siteId, title: "Open one", openedAt: new Date(Date.now() - 90 * 60_000),
      });
      await db.insert(schema.incidents).values({
        organisationId, siteId, title: "Fixed one", status: "resolved",
        openedAt: new Date(Date.now() - 90 * 60_000), resolvedAt: new Date(),
      });

      const { incidents } = await listIncidents(db, organisationId);
      const byTitle = Object.fromEntries(incidents.map((i) => [i.title, i]));
      expect(byTitle["Open one"]!.openMinutes).toBe(90);
      expect(byTitle["Fixed one"]!.openMinutes).toBeNull();
    });
  });

  it("leaves out the agent's write-up, which is for reading rather than scanning", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const siteId = await addSite(db, organisationId, clientId);
      await db.insert(schema.incidents).values({
        organisationId, siteId, title: "Site down", summaryMd: "## Root cause\nThe origin returned 502 for 4 minutes…",
      });

      expect(JSON.stringify((await listIncidents(db, organisationId)).incidents)).not.toContain("Root cause");
    });
  });

  it("filters by status", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const siteId = await addSite(db, organisationId, clientId);
      await db.insert(schema.incidents).values({ organisationId, siteId, title: "open" });
      await db.insert(schema.incidents).values({ organisationId, siteId, title: "resolved", status: "resolved" });

      expect((await listIncidents(db, organisationId, { status: "open" })).total).toBe(1);
      expect((await listIncidents(db, organisationId)).total).toBe(2);
    });
  });

  it("shows one organisation only its own", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const siteId = await addSite(db, a.organisationId, a.clientId);
      await db.insert(schema.incidents).values({ organisationId: a.organisationId, siteId, title: "A's" });

      expect((await listIncidents(db, a.organisationId)).total).toBe(1);
      expect((await listIncidents(db, b.organisationId)).total).toBe(0);
    });
  });
});
