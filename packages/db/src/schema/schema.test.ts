import { describe, expect, it } from "vitest";
import { withTestDb } from "../test/db.js";
import { organisations, clients, sites, monitors, incidents, tickets, agentRuns } from "./index.js";

describe("schema", () => {
  it("inserts an organisation → client → site → monitor → incident chain", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(organisations).values({ name: "LaunchFlow", slug: `test-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(clients).values({ organisationId: org!.id, name: "Grays CabLine" }).returning();
      const [site] = await db.insert(sites).values({ organisationId: org!.id, clientId: client!.id, name: "grayscabline.co.uk", primaryUrl: "https://grayscabline.co.uk" }).returning();
      const [monitor] = await db.insert(monitors).values({ organisationId: org!.id, siteId: site!.id, kind: "http", target: "https://grayscabline.co.uk" }).returning();
      const [incident] = await db.insert(incidents).values({ organisationId: org!.id, siteId: site!.id, monitorId: monitor!.id, severity: "high", title: "Site down" }).returning();
      expect(incident!.status).toBe("open");
      const [run] = await db.insert(agentRuns).values({ organisationId: org!.id, agentKey: "hosting-guard-dog", trigger: "event", input: {} }).returning();
      expect(run!.status).toBe("running");
      const [ticket] = await db.insert(tickets).values({ organisationId: org!.id, clientId: client!.id, siteId: site!.id, subject: "Site down", severity: "high", source: "monitor" }).returning();
      expect(ticket!.status).toBe("open");
    });
  });
});
