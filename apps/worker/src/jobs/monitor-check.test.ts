import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient, createMonitor, createSite } from "@launchos/core";
import { MockUptimeProbe } from "@launchos/integrations";
import { runMonitorSweep } from "./monitor-check.js";

describe("runMonitorSweep", () => {
  it("opens one incident after three failing sweeps and resolves it when the site recovers", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "S", primaryUrl: "https://s.test" });
      await createMonitor(db, org!.id, { siteId: site.id, target: "https://s.test" });
      const probe = new MockUptimeProbe(new Set(["https://s.test"]));

      const r1 = await runMonitorSweep(db, org!.id, probe);
      const r2 = await runMonitorSweep(db, org!.id, probe);
      const r3 = await runMonitorSweep(db, org!.id, probe);
      expect([r1.incidentsOpened, r2.incidentsOpened, r3.incidentsOpened]).toEqual([0, 0, 1]);
      expect(r3.checked).toBe(1);

      probe.downUrls.clear();
      const r4 = await runMonitorSweep(db, org!.id, probe);
      expect(r4.incidentsResolved).toBe(1);
      const incidents = await db.select().from(schema.incidents).where(eq(schema.incidents.siteId, site.id));
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.status).toBe("resolved");
    });
  });
});
