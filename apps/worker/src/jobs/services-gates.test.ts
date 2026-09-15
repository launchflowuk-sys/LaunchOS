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
  /**
   * The switch is the gate, and it is the *only* gate.
   *
   * Posting off owes nothing, and ads alone is not posting. But a client whose
   * switched-on service the package does not include **is** owed content now,
   * from `CONTENT_SERVICE_DEFAULTS` — that is the reversal, and it is the
   * whole reason the Content Writer had never run: every one of Shoji's
   * clients is on a legacy plan that includes no posts.
   */
  it("owes nothing where posting is switched off, and owes the defaults where the package includes none", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const off = await addClient(db, f.orgId, { name: "Paying, posting off", services: [] });
      const adsOnly = await addClient(db, f.orgId, { name: "Ads only", services: ["ads"] });
      const blogOnNoQuota = await addClient(db, f.orgId, {
        name: "Blog on, none in package", services: ["blog"], includes: { ...INCLUDES, blogPostsPerMonth: 0 },
      });

      const owed = (await clientsOwedContent(db, f.orgId)).map((c) => c.clientId);

      expect(owed).toContain(f.clientId);
      // The switch is on; the package's silence is filled by the defaults.
      expect(owed).toContain(blogOnNoQuota.clientId);
      // Off is still nothing, and ads is not content.
      for (const id of [off.clientId, adsOnly.clientId]) expect(owed).not.toContain(id);
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
