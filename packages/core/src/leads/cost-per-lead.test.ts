import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { MockAdsAdapter } from "@launchos/integrations";
import { createAdAccount } from "../ads/accounts.js";
import { campaignSpend, ingestDailyCampaignMetrics } from "../ads/campaigns.js";
import { ingestDailyMetrics } from "../ads/ingest.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { costPerLeadByCampaign, normaliseCampaign } from "./cost-per-lead.js";
import { createLead } from "./leads.js";

/** Puts a lead in the window with a chosen campaign, or none at all. */
async function leadFrom(db: Db, organisationId: string, name: string, utmCampaign?: string) {
  const lead = await createLead(db, organisationId, {
    name, phone: "07700 900000", source: "funnel", notifyOwner: false, acknowledge: false,
    ...(utmCampaign ? { attribution: { utmSource: "google", utmCampaign } } : {}),
  });
  await db.update(schema.leads).set({ createdAt: new Date("2026-08-15T10:00:00.000Z") }).where(eq(schema.leads.id, lead.id));
  return lead;
}

describe("normaliseCampaign", () => {
  it("reads spaces, underscores and case as the same campaign", () => {
    expect(normaliseCampaign(" Spring Offer ")).toBe("spring-offer");
    expect(normaliseCampaign("spring_offer")).toBe("spring-offer");
    expect(normaliseCampaign("SPRING-OFFER")).toBe("spring-offer");
  });
});

describe("ingestDailyCampaignMetrics", () => {
  it("writes one row per campaign, is idempotent, and its parts sum to the account's day", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await createAdAccount(db, organisationId, { clientId, platform: "google", externalId: "acct-1", name: "Search" });
      const ads = new MockAdsAdapter();

      const first = await ingestDailyCampaignMetrics(db, organisationId, { date: "2026-08-15" }, ads);
      expect(first).toMatchObject({ accounts: 1, campaigns: 3, unsupported: 0 });
      const second = await ingestDailyCampaignMetrics(db, organisationId, { date: "2026-08-15" }, ads);
      expect(second.campaigns).toBe(3);
      // Scoped to this organisation: the dev seed writes a month of campaign
      // snapshots into its own, and an unscoped count would read those too.
      expect(await db.select().from(schema.adCampaignSnapshots)
        .where(eq(schema.adCampaignSnapshots.organisationId, organisationId))).toHaveLength(3);

      await ingestDailyMetrics(db, organisationId, { date: "2026-08-15" }, ads);
      const totals = await campaignSpend(db, organisationId, { from: "2026-08-15", to: "2026-08-15" });
      // The campaign rows account for every penny of the day, which is what
      // lets the screen say honestly how much of the budget it placed.
      expect(totals.campaignSpendPence).toBe(totals.accountSpendPence);
      expect(totals.campaigns.map((c) => c.campaignName).sort()).toEqual(["brand-search", "local-services", "spring-offer"]);
    });
  });

  it("skips an adapter that cannot break a day down rather than failing the run", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await createAdAccount(db, organisationId, { clientId, platform: "google", externalId: "acct-1", name: "Search" });
      const blind = { name: "mock" as const, listAccounts: async () => [], fetchDailyMetrics: async () => { throw new Error("unused"); } };
      const result = await ingestDailyCampaignMetrics(db, organisationId, { date: "2026-08-15" }, blind);
      expect(result).toMatchObject({ accounts: 1, unsupported: 1, campaigns: 0, failed: [] });
    });
  });

  it("keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await createAdAccount(db, a.organisationId, { clientId: a.clientId, platform: "google", externalId: "acct-a", name: "Search" });
      await ingestDailyCampaignMetrics(db, a.organisationId, { date: "2026-08-15" }, new MockAdsAdapter());
      const other = await campaignSpend(db, b.organisationId, { from: "2026-08-01", to: "2026-08-31" });
      expect(other.campaigns).toHaveLength(0);
      expect(other.accountSpendPence).toBe(0);
    });
  });
});

describe("costPerLeadByCampaign", () => {
  it("joins leads to spend by campaign, and never dresses a missing side up as a zero", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await createAdAccount(db, organisationId, { clientId, platform: "google", externalId: "acct-1", name: "Search" });
      const ads = new MockAdsAdapter({ campaigns: ["spring-offer", "brand-search"] });
      await ingestDailyMetrics(db, organisationId, { date: "2026-08-15" }, ads);
      await ingestDailyCampaignMetrics(db, organisationId, { date: "2026-08-15" }, ads);

      // Two leads from a campaign we bought, spelled two ways; one from a
      // campaign we never ran; one with no campaign at all.
      await leadFrom(db, organisationId, "Aisha", "Spring Offer");
      await leadFrom(db, organisationId, "Bilal", "spring_offer");
      await leadFrom(db, organisationId, "Chris", "newsletter-june");
      await leadFrom(db, organisationId, "Dee");

      const report = await costPerLeadByCampaign(db, organisationId, { from: "2026-08-01", to: "2026-08-31" });
      expect(report.totalLeads).toBe(4);
      expect(report.attributedLeads).toBe(3);
      expect(report.matchedLeads).toBe(2);

      const spring = report.rows.find((row) => row.campaign === "Spring Offer")!;
      expect(spring.leads).toBe(2);
      expect(spring.spendPence).toBeGreaterThan(0);
      expect(spring.costPerLeadPence).toBe(Math.round(spring.spendPence! / 2));

      // Spend with no leads keeps its own row — the most useful line here.
      const brand = report.rows.find((row) => row.campaign === "brand-search")!;
      expect(brand.leads).toBe(0);
      expect(brand.costPerLeadPence).toBeNull();

      // Leads with no matched spend cost null, never zero.
      const newsletter = report.rows.find((row) => row.campaign === "newsletter-june")!;
      expect(newsletter).toMatchObject({ leads: 1, spendPence: null, costPerLeadPence: null });

      // And the unattributed row is its own line, last, never folded in.
      const none = report.rows.at(-1)!;
      expect(none).toMatchObject({ campaign: null, leads: 1, spendPence: null, costPerLeadPence: null });

      expect(report.accountSpendPence).toBeGreaterThan(0);
      expect(report.placedSpendPence).toBe(spring.spendPence);
      expect(report.placedSpendPence).toBeLessThan(report.accountSpendPence);
    });
  });

  it("refuses a period that runs backwards and keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await leadFrom(db, a.organisationId, "Only A", "spring-offer");
      await expect(costPerLeadByCampaign(db, a.organisationId, { from: "2026-08-31", to: "2026-08-01" })).rejects.toThrow(/starts after/);
      const other = await costPerLeadByCampaign(db, b.organisationId, { from: "2026-08-01", to: "2026-08-31" });
      expect(other.totalLeads).toBe(0);
      expect(other.rows).toHaveLength(0);
    });
  });
});
