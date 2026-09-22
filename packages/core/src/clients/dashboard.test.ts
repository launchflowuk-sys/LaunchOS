import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { describe, expect, it } from "vitest";
import { seedPortalShowcase } from "../demo/portal-showcase.js";
import { clientDashboard } from "./dashboard.js";

const NOW = new Date("2026-09-22T12:00:00Z");

async function organisation(db: Db): Promise<string> {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `dash-${randomUUID()}` }).returning();
  return org!.id;
}

describe("clientDashboard", () => {
  /**
   * Read against the six-month demo record, because the figures only mean
   * anything together. A dashboard assembled from separate queries can say
   * "99.9% uptime" beside "2 incidents" beside a chart drawn from a third
   * read, and be wrong in a way no single assertion catches.
   */
  it("reads a client's whole dashboard from six months of history", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const { clientId } = await seedPortalShowcase(db, orgId, NOW);

      const d = await clientDashboard(db, orgId, clientId, NOW);

      expect(d.site?.name).toBe("Northgate Blinds");
      expect(d.site?.status).toBe("live");
      // No bytes were captured, and the UI has to be able to say so honestly
      // rather than render a broken image.
      expect(d.site?.hasScreenshot).toBe(false);

      expect(d.domain?.name).toBe("northgateblinds.example");
      expect(d.plan?.amountPence).toBe(11000);
      expect(d.plan?.status).toBe("active");

      // One invoice still owing, from the seed.
      expect(d.invoices.outstandingCount).toBe(1);
      expect(d.invoices.outstandingPence).toBe(11000);
    });
  });

  /**
   * The two figures the design leans on. Uptime short of 100 proves the
   * outages are counted; a response time that improved proves the trend is
   * measured rather than decorative.
   */
  it("measures uptime and a response time that is getting better", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const { clientId } = await seedPortalShowcase(db, orgId, NOW);

      const d = await clientDashboard(db, orgId, clientId, NOW);

      expect(d.uptime.percent).toBeGreaterThan(98);
      expect(d.uptime.percent).toBeLessThan(100);
      expect(d.uptime.up).toBe(true);
      expect(d.uptime.lastCheckedAt).not.toBeNull();

      expect(d.uptime.responseMs).toBeGreaterThan(0);
      // The seed drifts response time down, so the trend is a fall — and a
      // fall in response time is good news, which is the distinction the
      // `good` flag exists to carry.
      expect(d.uptime.responseTrend?.changePercent).toBeLessThan(0);
      expect(d.uptime.responseTrend?.good).toBe(true);

      // One point per day over the window, for the chart.
      expect(d.uptime.responseSeries.length).toBeGreaterThan(20);
      expect(d.uptime.responseSeries.every((n) => n > 0)).toBe(true);
    });
  });

  it("counts the work and the support load", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const { clientId } = await seedPortalShowcase(db, orgId, NOW);

      const d = await clientDashboard(db, orgId, clientId, NOW);

      expect(d.support.open).toBe(2);
      expect(d.support.resolvedThisWindow).toBeGreaterThan(0);
      expect(d.support.firstResponseHours).toBeGreaterThan(0);
      expect(d.work.inProgress + d.work.waitingOnClient).toBeGreaterThan(0);
      // One of the two seeded outages falls inside the 30-day window, resolved.
      expect(d.incidents.opened).toBe(1);
      expect(d.incidents.resolved).toBe(1);
    });
  });

  /**
   * A brand-new client is the other state this has to survive, and the one
   * that breaks a dashboard written only against data: every figure must come
   * back null or zero rather than throwing or reading as "always down".
   */
  it("is all nulls and zeroes for a client with nothing yet, and never zero uptime", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const [client] = await db.insert(schema.clients).values({
        organisationId: orgId, name: "Brand New", slug: `new-${randomUUID()}`,
      }).returning();

      const d = await clientDashboard(db, orgId, client!.id, NOW);

      expect(d.site).toBeNull();
      expect(d.domain).toBeNull();
      expect(d.plan).toBeNull();
      // Null, not 0. Zero would render as "0% uptime", which says the site is
      // down rather than that nothing has been measured.
      expect(d.uptime.percent).toBeNull();
      expect(d.uptime.up).toBeNull();
      expect(d.uptime.responseSeries).toEqual([]);
      expect(d.support.open).toBe(0);
      expect(d.support.firstResponseHours).toBeNull();
      expect(d.invoices.outstandingPence).toBe(0);
      expect(d.activity).toEqual([]);
    });
  });

  /** One client's dashboard never contains another's rows. */
  it("keeps one client's figures out of another's", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      await seedPortalShowcase(db, orgId, NOW);
      const [other] = await db.insert(schema.clients).values({
        organisationId: orgId, name: "Someone Else", slug: `other-${randomUUID()}`,
      }).returning();

      const d = await clientDashboard(db, orgId, other!.id, NOW);

      expect(d.site).toBeNull();
      expect(d.support.open).toBe(0);
      expect(d.invoices.outstandingCount).toBe(0);
    });
  });
});
