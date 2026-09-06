import { describe, expect, it } from "vitest";
import { GoogleAdsAdapter, MetaAdsAdapter, MockAdsAdapter, createAdsAdapter } from "./index.js";

describe("MockAdsAdapter", () => {
  it("is deterministic for the same account and date", async () => {
    const a = new MockAdsAdapter();
    const b = new MockAdsAdapter();
    const first = await a.fetchDailyMetrics("acct-1", "2026-09-01");
    const second = await b.fetchDailyMetrics("acct-1", "2026-09-01");
    expect(second).toEqual(first);
  });

  it("varies by account and by date", async () => {
    const ads = new MockAdsAdapter();
    const day1 = await ads.fetchDailyMetrics("acct-1", "2026-09-01");
    const day2 = await ads.fetchDailyMetrics("acct-1", "2026-09-02");
    const other = await ads.fetchDailyMetrics("acct-2", "2026-09-01");
    expect(day2.clicks).not.toBe(day1.clicks);
    expect(other.clicks).not.toBe(day1.clicks);
  });

  it("returns internally consistent figures", async () => {
    const ads = new MockAdsAdapter();
    const m = await ads.fetchDailyMetrics("acct-1", "2026-09-01");
    expect(m.clicks).toBeLessThan(m.impressions);
    expect(m.conversions).toBeLessThanOrEqual(m.clicks);
    expect(m.cpcPence).toBeCloseTo(m.spendPence / m.clicks, 4);
    expect(m.roas).toBeCloseTo(m.conversionValuePence / m.spendPence, 4);
  });

  it("drops ROAS from the configured date onwards", async () => {
    const ads = new MockAdsAdapter({ dropFrom: "2026-09-10" });
    const before = await ads.fetchDailyMetrics("acct-1", "2026-09-09");
    const after = await ads.fetchDailyMetrics("acct-1", "2026-09-10");
    expect(after.roas).toBeLessThan(before.roas * 0.7);
    expect(after.spendPence).toBeGreaterThan(0);
  });

  it("raises CPC from the configured date onwards", async () => {
    const ads = new MockAdsAdapter({ dropFrom: "2026-09-10" });
    const before = await ads.fetchDailyMetrics("acct-1", "2026-09-09");
    const after = await ads.fetchDailyMetrics("acct-1", "2026-09-10");
    expect(after.cpcPence).toBeGreaterThan(before.cpcPence);
  });

  it("lists its configured accounts", async () => {
    const ads = new MockAdsAdapter({
      accounts: [{ externalId: "123-456-7890", platform: "google", name: "Search", currency: "GBP" }],
    });
    expect(await ads.listAccounts()).toHaveLength(1);
  });
});

describe("real ad adapters", () => {
  it("refuse to construct without credentials", () => {
    expect(() => new GoogleAdsAdapter({})).toThrow(/credentials required/i);
    expect(() => new MetaAdsAdapter({})).toThrow(/credentials required/i);
  });
});

describe("createAdsAdapter", () => {
  it("defaults to the mock adapter", () => {
    expect(createAdsAdapter({} as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createAdsAdapter({ ADS_ADAPTER: "google" } as NodeJS.ProcessEnv).name).toBe("mock");
  });
});

describe("MockAdsAdapter fetchCampaignMetrics", () => {
  it("splits the day across campaigns without losing a penny, and is stable across runs", async () => {
    const ads = new MockAdsAdapter();
    const day = await ads.fetchDailyMetrics("acct-1", "2026-09-01");
    const rows = await ads.fetchCampaignMetrics("acct-1", "2026-09-01");

    expect(rows.map((r) => r.campaignName)).toEqual(["spring-offer", "brand-search", "local-services"]);
    expect(rows.reduce((sum, r) => sum + r.spendPence, 0)).toBe(day.spendPence);
    expect(rows.reduce((sum, r) => sum + r.clicks, 0)).toBe(day.clicks);
    expect(await ads.fetchCampaignMetrics("acct-1", "2026-09-01")).toEqual(rows);
    expect(await ads.fetchCampaignMetrics("acct-2", "2026-09-01")).not.toEqual(rows);
  });

  it("returns nothing when it is configured with no campaigns", async () => {
    expect(await new MockAdsAdapter({ campaigns: [] }).fetchCampaignMetrics("acct-1", "2026-09-01")).toEqual([]);
  });
});
