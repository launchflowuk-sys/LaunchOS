import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockAdsAdapter, type AdsAdapter, type AdDailyMetrics } from "@launchos/integrations";
import { createAdAccount, listAdAccounts } from "./accounts.js";
import { AdIngestError, ingestDailyMetrics, isPermanentAuthFailure } from "./ingest.js";

/** Every account fails the same way: the provider refusing our credentials. */
class RejectedCredentialsAdapter implements AdsAdapter {
  readonly name = "mock" as const;
  private readonly good = new MockAdsAdapter();
  constructor(private readonly message: string) {}
  async listAccounts() {
    return this.good.listAccounts();
  }
  async fetchDailyMetrics(): Promise<AdDailyMetrics> {
    throw new Error(this.message);
  }
}

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

describe("isPermanentAuthFailure", () => {
  /**
   * Google answers all of these with a 401 that looks like any other, so the
   * difference is in the body.
   */
  it("recognises the OAuth failures a retry cannot fix", () => {
    expect(isPermanentAuthFailure("google ads api 401: deleted_client: The OAuth client was deleted.")).toBe(true);
    expect(isPermanentAuthFailure("invalid_grant: Token has been expired or revoked.")).toBe(true);
    expect(isPermanentAuthFailure("unauthorized_client")).toBe(true);
  });

  it("leaves ordinary failures alone", () => {
    expect(isPermanentAuthFailure("provider timeout")).toBe(false);
    expect(isPermanentAuthFailure("429 RESOURCE_EXHAUSTED")).toBe(false);
    expect(isPermanentAuthFailure("500 internal error")).toBe(false);
  });
});

describe("ingestDailyMetrics — rejected credentials", () => {
  /**
   * The bug this fixes: a deleted OAuth client threw like any other failure,
   * so pg-boss retried it every ten minutes for a day and buried everything
   * else in the log.
   */
  it("does not throw when every account failed on credentials", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      await createAdAccount(db, orgId, { clientId, platform: "google", externalId: "123-456-7890", name: "Grays" });
      const adapter = new RejectedCredentialsAdapter("google ads api 401: deleted_client: The OAuth client was deleted.");

      const result = await ingestDailyMetrics(db, orgId, { date: "2026-09-09" }, adapter);

      expect(result.credentialsRejected).toBe(true);
      expect(result.failed).toHaveLength(1);
      expect(result.snapshots).toBe(0);
    });
  });

  it("still throws for an ordinary failure, so the retry happens", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      await createAdAccount(db, orgId, { clientId, platform: "google", externalId: "123-456-7890", name: "Grays" });
      const adapter = new RejectedCredentialsAdapter("provider timeout");

      await expect(ingestDailyMetrics(db, orgId, { date: "2026-09-09" }, adapter)).rejects.toBeInstanceOf(AdIngestError);
    });
  });

  it("tells the owner, and only once a day", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const [owner] = await db
        .insert(schema.user)
        .values({ id: randomUUID(), name: "Shoji", email: `owner-${randomUUID()}@example.test`, emailVerified: true })
        .returning();
      await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: owner!.id, role: "owner", status: "active" });
      await createAdAccount(db, orgId, { clientId, platform: "google", externalId: "123-456-7890", name: "Grays" });
      const adapter = new RejectedCredentialsAdapter("deleted_client");

      await ingestDailyMetrics(db, orgId, { date: "2026-09-09" }, adapter);
      await ingestDailyMetrics(db, orgId, { date: "2026-09-09" }, adapter);
      await ingestDailyMetrics(db, orgId, { date: "2026-09-09" }, adapter);

      const bells = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, "ads.credentials_rejected"));
      // A standing fault says so once. More than that and the bell becomes
      // something to ignore.
      expect(bells).toHaveLength(1);
    });
  });
});
