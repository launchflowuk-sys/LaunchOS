import { describe, expect, it, vi } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { createClient, createSite, openIncident } from "@launchos/core";
import { randomUUID } from "node:crypto";
import { dispatchEvent, type BossSender } from "./dispatch-event.js";

function fakeBoss() {
  const send = vi.fn(async () => "job-id");
  return { send } as unknown as BossSender;
}

describe("dispatchEvent", () => {
  it("routes client.created to tasks.generate-onboarding with the onboarding singleton key", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const organisationId = randomUUID();
      const clientId = randomUUID();

      await dispatchEvent({ db, boss }, { name: "client.created", organisationId, clientId });

      expect(boss.send).toHaveBeenCalledWith(
        "tasks.generate-onboarding",
        { organisationId, clientId },
        { singletonKey: `onboarding:${clientId}` },
      );
    });
  });

  it("still routes incident.opened to agent.run for the guard-dog agent", async () => {
    await withTestDb(async (db) => {
      const boss = fakeBoss();
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${randomUUID()}` }).returning();
      const client = await createClient(db, org!.id, { name: "C" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "S", primaryUrl: "https://s.test" });
      const incident = await openIncident(db, org!.id, { siteId: site.id, title: "S down", severity: "critical" });

      await dispatchEvent({ db, boss }, { name: "incident.opened", organisationId: org!.id, incidentId: incident.id });

      expect(boss.send).toHaveBeenCalledWith(
        "agent.run",
        expect.objectContaining({ agentKey: "hosting-guard-dog", organisationId: org!.id }),
        { singletonKey: `guard-dog:${incident.id}` },
      );
    });
  });
});
