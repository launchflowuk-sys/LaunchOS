import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockAdsAdapter, type AdsAdapter, type AdDailyMetrics } from "@launchos/integrations";
import { createAdAccount, listAdAccounts } from "./accounts.js";
import { AdIngestError, ingestDailyMetrics } from "./ingest.js";

/** Passes through to the deterministic mock for every account except one, which always throws. */
class PartiallyFailingAdsAdapter implements AdsAdapter {
  readonly name = "mock" as const;
  private readonly good = new MockAdsAdapter();
  constructor(private readonly failingExternalId: string) {}
  async listAccounts() {
    return this.good.listAccounts();
  }
  async fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics> {
    if (accountId === this.failingExternalId) throw new Error("provider timeout");
    return this.good.fetchDailyMetrics(accountId, date);
  }
}

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

  it("isolates one account's failure: the other account still gets its snapshot, and an aggregate error is thrown", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const good = await createAdAccount(db, orgId, { clientId, platform: "google", externalId: "good-1", name: "Good" });
      const bad = await createAdAccount(db, orgId, { clientId, platform: "google", externalId: "bad-1", name: "Bad" });
      const adapter = new PartiallyFailingAdsAdapter("bad-1");

      let caught: unknown;
      try {
        await ingestDailyMetrics(db, orgId, { date: "2026-09-01" }, adapter);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AdIngestError);
      const result = (caught as AdIngestError).result;
      expect(result).toMatchObject({ date: "2026-09-01", accounts: 2, snapshots: 1 });
      expect(result.failed).toEqual([{ adAccountId: bad.id, error: "provider timeout" }]);

      const goodRows = await db.select().from(schema.adMetricSnapshots).where(eq(schema.adMetricSnapshots.adAccountId, good.id));
      expect(goodRows).toHaveLength(1);
      const badRows = await db.select().from(schema.adMetricSnapshots).where(eq(schema.adMetricSnapshots.adAccountId, bad.id));
      expect(badRows).toHaveLength(0);
    });
  });
});
