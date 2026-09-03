import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient, createMonitor, createSite, openIncident } from "@launchos/core";
import { MockHostingProvider, MockUptimeProbe } from "@launchos/integrations";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { runAgent } from "../../kernel/run-agent.js";
import { hostingGuardDog } from "./index.js";

describe("hosting-guard-dog", () => {
  it("diagnoses an open incident, opens a ticket and acknowledges the incident", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: "gd" }).returning();
      const client = await createClient(db, org!.id, { name: "Grays CabLine" });
      const site = await createSite(db, org!.id, { clientId: client.id, name: "grayscabline.co.uk", primaryUrl: "https://grayscabline.co.uk" });
      const monitor = await createMonitor(db, org!.id, { siteId: site.id, target: site.primaryUrl });
      const incident = await openIncident(db, org!.id, { siteId: site.id, monitorId: monitor.id, title: "grayscabline.co.uk is down" });

      const integrations = { uptime: new MockUptimeProbe(new Set([site.primaryUrl])), hosting: new MockHostingProvider({ app_1: { status: "exited" } }) };
      const agent = hostingGuardDog(integrations);
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "uptime_check_site", { url: site.primaryUrl }), toolUse("t2", "hosting_get_resources", { hostingRef: "app_1" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("t3", "tickets_create", { clientId: client.id, siteId: site.id, subject: "Site down: container exited", body: "Container exited; 503 from origin.", severity: "critical", category: "hosting" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("t4", "incidents_update", { incidentId: incident.id, status: "acknowledged", summaryMd: "## Diagnosis\nContainer exited." })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [text("Acknowledged incident and opened a critical ticket.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "event", payload: { incidentId: incident.id, siteId: site.id, clientId: client.id, url: site.primaryUrl, hostingRef: "app_1" }, llm, policy: "safe", logger: console });
      expect(result.status).toBe("completed");

      const [updated] = await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id));
      expect(updated!.status).toBe("acknowledged");
      expect(updated!.agentRunId).toBe(result.runId);
      const tickets = await db.select().from(schema.tickets).where(eq(schema.tickets.siteId, site.id));
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.severity).toBe("critical");
      expect(tickets[0]!.source).toBe("agent");
    });
  });
});
