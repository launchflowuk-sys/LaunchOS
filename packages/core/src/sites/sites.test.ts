import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createSite } from "./create-site.js";
import { getSite, listSites } from "./list-sites.js";
import { updateSite } from "./update-site.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("sites", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => { events.length = 0; setEnqueue(async (e) => { events.push(e); }); });

  it("creates, emits site.created, updates and lists with the client name and domain count", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });
      events.length = 0; // createClient also emits client.created; isolate the event under test

      const site = await createSite(db, org.id, {
        clientId: client.id, name: "acme.test", primaryUrl: "https://acme.test", platform: "nextjs", actorKind: "user", actorId: "u1",
      });
      expect(site.platform).toBe("nextjs");
      expect(events).toEqual([{ name: "site.created", organisationId: org.id, siteId: site.id }]);

      await db.insert(schema.domains).values({ organisationId: org.id, clientId: client.id, siteId: site.id, name: `d-${crypto.randomUUID()}.test` });

      const paused = await updateSite(db, org.id, { siteId: site.id, status: "paused", hostingRef: "coolify-uuid" });
      expect(paused.status).toBe("paused");

      const [row] = await listSites(db, org.id, { clientId: client.id });
      expect(row!.clientName).toBe("Acme");
      expect(row!.domainCount).toBe(1);
      expect(row!.openIncidentCount).toBe(0);
      expect((await getSite(db, org.id, site.id))?.hostingRef).toBe("coolify-uuid");
    });
  });
});
