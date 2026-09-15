import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteSite, siteDeletionReport } from "./delete-site.js";

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `ds-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "Gateway Taxis", slug: `gw-${randomUUID()}`,
  }).returning();
  const make = async (url: string) => {
    const [site] = await db.insert(schema.sites).values({
      organisationId: org!.id, clientId: client!.id, name: "Gateway Taxis", primaryUrl: url,
    }).returning();
    return site!;
  };
  return { organisationId: org!.id, clientId: client!.id, make };
}

describe("deleteSite", () => {
  /**
   * The situation it was built for: two rows with the *same name* for
   * gatewaytaxis.co.uk, four days apart, and no way in the product to remove
   * either. Which is also why the confirmation is the address and not the
   * name — typing "Gateway Taxis" would confirm nothing about which one goes.
   */
  it("deletes a duplicate row and leaves its twin alone", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const keep = await f.make("https://gatewaytaxis.co.uk");
      const dupe = await f.make("https://gatewaytaxis.co.uk/");

      await deleteSite(db, f.organisationId, { siteId: dupe.id, confirmUrl: "https://gatewaytaxis.co.uk/", actorId: "user-1" });

      const left = await db.select({ id: schema.sites.id }).from(schema.sites)
        .where(and(eq(schema.sites.organisationId, f.organisationId), eq(schema.sites.clientId, f.clientId)));
      expect(left.map((r) => r.id)).toEqual([keep.id]);
    });
  });

  it("writes the audit row before the site is gone", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const site = await f.make("https://gone.example");
      await deleteSite(db, f.organisationId, { siteId: site.id, confirmUrl: "https://gone.example", actorId: "user-1" });

      const audits = await db.select({ action: schema.auditLog.action, targetId: schema.auditLog.targetId })
        .from(schema.auditLog).where(eq(schema.auditLog.organisationId, f.organisationId));
      // The record of what was destroyed has to outlive the thing.
      expect(audits.some((a) => a.action === "site.deleted" && a.targetId === site.id)).toBe(true);
    });
  });

  it("refuses the wrong address, trailing slash aside", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const site = await f.make("https://gatewaytaxis.co.uk");

      await expect(deleteSite(db, f.organisationId, { siteId: site.id, confirmUrl: "gatewaytaxis.co.uk" }))
        .rejects.toThrow(/Type https:\/\/gatewaytaxis\.co\.uk exactly/);
      // A trailing slash and case are not a different address.
      await deleteSite(db, f.organisationId, { siteId: site.id, confirmUrl: "HTTPS://GATEWAYTAXIS.CO.UK/" });
    });
  });

  /**
   * It refuses rather than cascades. A monitor, domain, incident or case
   * attached to a site is history somebody would go looking for, and a quiet
   * cascade is unrecoverable — whereas a refusal that names the blocker is a
   * thirty-second job to clear.
   */
  it("refuses while a monitor or a domain depends on it, and names which", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const site = await f.make("https://watched.example");
      await db.insert(schema.monitors).values({ organisationId: f.organisationId, siteId: site.id, target: "https://watched.example" });

      let report = await siteDeletionReport(db, f.organisationId, site.id);
      expect(report.deletable).toBe(false);
      expect(report.blockers.map((b) => b.kind)).toContain("monitor");
      await expect(deleteSite(db, f.organisationId, { siteId: site.id, confirmUrl: "https://watched.example" }))
        .rejects.toThrow(/monitor/);

      await db.delete(schema.monitors).where(eq(schema.monitors.siteId, site.id));
      await db.insert(schema.domains).values({
        organisationId: f.organisationId, clientId: f.clientId, siteId: site.id, name: `watched-${randomUUID()}.example`,
      });
      report = await siteDeletionReport(db, f.organisationId, site.id);
      expect(report.blockers.map((b) => b.kind)).toContain("domain");

      // Clear it and the same button works.
      await db.delete(schema.domains).where(eq(schema.domains.siteId, site.id));
      await deleteSite(db, f.organisationId, { siteId: site.id, confirmUrl: "https://watched.example" });
    });
  });

  it("says out loud what cascades with it", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const site = await f.make("https://shot.example");
      await db.insert(schema.siteScreenshots).values({
        organisationId: f.organisationId, siteId: site.id, adapter: "mock", sizeBytes: 0,
      });

      const report = await siteDeletionReport(db, f.organisationId, site.id);
      expect(report.deletable).toBe(true);
      expect(report.cascades.join(" ")).toMatch(/screenshot/);
    });
  });

  it("will not touch another organisation's site", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db);
      const site = await theirs.make("https://theirs.example");
      await expect(siteDeletionReport(db, mine.organisationId, site.id)).rejects.toThrow();
    });
  });
});
