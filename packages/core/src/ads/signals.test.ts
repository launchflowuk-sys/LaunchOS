import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { createAdAccount } from "./accounts.js";
import { computeAccountSignals } from "./signals.js";

const NOW = new Date("2026-09-15T07:00:00Z");

/** `offset` days back from 2026-09-15, as an ISO calendar date. */
function dayBefore(offset: number): string {
  return new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

async function accountWithSnapshots(db: Db, recentRoas: number, priorRoas: number, recentCpc = 60, priorCpc = 60) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sig-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  const account = await createAdAccount(db, org!.id, { clientId: client!.id, platform: "google", externalId: "acct-1", name: "Search" });

  const rows = [] as (typeof schema.adMetricSnapshots.$inferInsert)[];
  for (let offset = 1; offset <= 14; offset++) {
    const recent = offset <= 7;
    const spendPence = 10_000;
    const cpcPence = recent ? recentCpc : priorCpc;
    const roas = recent ? recentRoas : priorRoas;
    rows.push({
      organisationId: org!.id, adAccountId: account.id, date: dayBefore(offset),
      spendPence, impressions: 5000, clicks: Math.round(spendPence / cpcPence),
      conversions: 10, conversionValuePence: Math.round(spendPence * roas),
      cpcPence, roas,
    });
  }
  await db.insert(schema.adMetricSnapshots).values(rows);
  return { orgId: org!.id, accountId: account.id };
}

describe("computeAccountSignals", () => {
  it("flags a ROAS drop over 20 percent", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await accountWithSnapshots(db, 3, 5);
      const signals = await computeAccountSignals(db, orgId, accountId, { now: NOW });
      expect(signals.current.days).toBe(7);
      expect(signals.previous.days).toBe(7);
      expect(signals.roasDeltaPercent).toBeCloseTo(-40, 1);
      expect(signals.flagged).toBe(true);
      expect(signals.reasons.join(" ")).toMatch(/ROAS/);
    });
  });

  it("flags a CPC rise over 30 percent", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await accountWithSnapshots(db, 5, 5, 100, 60);
      const signals = await computeAccountSignals(db, orgId, accountId, { now: NOW });
      expect(signals.cpcDeltaPercent).toBeGreaterThan(30);
      expect(signals.flagged).toBe(true);
      expect(signals.reasons.join(" ")).toMatch(/CPC/);
    });
  });

  it("does not flag a steady account", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await accountWithSnapshots(db, 5, 5);
      const signals = await computeAccountSignals(db, orgId, accountId, { now: NOW });
      expect(signals.flagged).toBe(false);
      expect(signals.reasons).toEqual([]);
    });
  });

  it("does not flag when there is no prior window to compare against", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sig2-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
      const account = await createAdAccount(db, org!.id, { clientId: client!.id, platform: "google", externalId: "a", name: "A" });
      await db.insert(schema.adMetricSnapshots).values({
        organisationId: org!.id, adAccountId: account.id, date: dayBefore(1),
        spendPence: 1000, impressions: 100, clicks: 10, conversions: 1,
        conversionValuePence: 5000, cpcPence: 100, roas: 5,
      });
      const signals = await computeAccountSignals(db, org!.id, account.id, { now: NOW });
      expect(signals.previous.days).toBe(0);
      expect(signals.flagged).toBe(false);
    });
  });
});
