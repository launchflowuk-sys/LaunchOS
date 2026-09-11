import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CONTENT_WRITER_KEY, type LlmClient } from "@launchos/agents";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { handleContentDraft } from "./content-draft.js";
import { clientsOwedContent } from "./content-plan-month.js";
import { addClient, contentJobFixture, INCLUDES, silentLogger } from "./content-test-fixture.js";

/** The worker's side of the service switches: nothing is owed and nothing is written for work nobody switched on. */

describe("clientsOwedContent and the service switches", () => {
  it("owes nothing to a paying client whose posting is switched off, or whose switched-on service the package does not include", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const off = await addClient(db, f.orgId, { name: "Paying, posting off", services: [] });
      const adsOnly = await addClient(db, f.orgId, { name: "Ads only", services: ["ads"] });
      const blogOnNoQuota = await addClient(db, f.orgId, {
        name: "Blog on, none in package", services: ["blog"], includes: { ...INCLUDES, blogPostsPerMonth: 0 },
      });

      const owed = (await clientsOwedContent(db, f.orgId)).map((c) => c.clientId);

      expect(owed).toEqual([f.clientId]);
      for (const id of [off.clientId, adsOnly.clientId, blogOnNoQuota.clientId]) expect(owed).not.toContain(id);
    });
  });
});

describe("handleContentDraft and the service switches", () => {
  it("starts no writer run for a client with no content service on, and says why in the ledger", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db, { services: ["ads"] });
      await db.insert(schema.agentEnablement).values({ organisationId: f.orgId, agentKey: CONTENT_WRITER_KEY, enabled: true });
      // No registry and no model: reaching either would throw, which is the point.
      const deps = { db, registry: {}, llm: {} as LlmClient, policy: "safe" as const, logger: silentLogger() };

      await handleContentDraft(deps, { organisationId: f.orgId, clientId: f.clientId, periodKey: "2026-09", trigger: "manual" });

      const runs = await db.select().from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.organisationId, f.orgId), eq(schema.agentRuns.agentKey, CONTENT_WRITER_KEY)));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "skipped", trigger: "manual" });
      expect(runs[0]!.summary).toContain("Services tab");
    });
  });
});
