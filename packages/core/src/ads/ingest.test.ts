import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockAdsAdapter } from "@launchos/integrations";
import { createAdAccount, listAdAccounts } from "./accounts.js";
import { ingestDailyMetrics } from "./ingest.js";

async function orgWithClient(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `ads-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  return { orgId: org!.id, clientId: client!.id };
}

describe("createAdAccount / listAdAccounts", () => {
  it("creates an account and lists it with its client name", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, {
        clientId, platform: "google", externalId: "123-456-7890", name: "Grays CabLine — Search",
        actorKind: "user", actorId: "u1",
      });
      expect(account.status).toBe("active");
      const listed = await listAdAccounts(db, orgId);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.clientName).toBe("Grays CabLine");
    });
  });
});

describe("ingestDailyMetrics", () => {
  it("writes one snapshot per active account and is idempotent for the same date", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, { clientId, platform: "google", externalId: "acct-1", name: "Search" });
      const ads = new MockAdsAdapter();

      const first = await ingestDailyMetrics(db, orgId, { date: "2026-09-01" }, ads);
      expect(first).toMatchObject({ date: "2026-09-01", accounts: 1, snapshots: 1 });

      const second = await ingestDailyMetrics(db, orgId, { date: "2026-09-01" }, ads);
      expect(second.snapshots).toBe(1);

      const rows = await db.select().from(schema.adMetricSnapshots)
        .where(eq(schema.adMetricSnapshots.adAccountId, account.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.clicks).toBeGreaterThan(0);
      expect(rows[0]!.roas).toBeGreaterThan(0);
    });
  });

  it("skips paused accounts", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      await createAdAccount(db, orgId, { clientId, platform: "meta", externalId: "act_1", name: "Meta", status: "paused" });
      const result = await ingestDailyMetrics(db, orgId, { date: "2026-09-01" }, new MockAdsAdapter());
      expect(result).toMatchObject({ accounts: 0, snapshots: 0 });
    });
  });
});
