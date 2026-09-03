import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { createSite } from "../sites/create-site.js";
import { createMonitor } from "./create-monitor.js";
import { recordCheck } from "./record-check.js";

describe("recordCheck", () => {
  it("opens an incident on the 3rd consecutive failure and resolves on recovery", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "t" }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "S", primaryUrl: "https://s.test" });
      const monitor = await createMonitor(db, org!.id, { siteId: site.id, target: "https://s.test" });

      const r1 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      const r2 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      const r3 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      expect([r1.shouldOpenIncident, r2.shouldOpenIncident, r3.shouldOpenIncident]).toEqual([false, false, true]);
      expect(r3.consecutiveFailures).toBe(3);

      const r4 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: false, error: "timeout" });
      expect(r4.shouldOpenIncident).toBe(false); // only fires once at the threshold

      const r5 = await recordCheck(db, org!.id, { monitorId: monitor.id, ok: true, statusCode: 200, latencyMs: 120 });
      expect(r5.consecutiveFailures).toBe(0);
      expect(r5.shouldResolveIncident).toBe(true);
    });
  });
});
