import { describe, expect, it } from "vitest";
import { createAdsAdapter, createAdsAdapterFromEnv, hasGoogleAdsCredentials, hasMetaAdsCredentials } from "./index.js";
import { decimalToMinorUnits, microsToMinorUnits } from "./money.js";
import { MultiPlatformAdsAdapter, inferPlatform } from "./routing.js";
import type { AdAccountSummary, AdDailyMetrics, AdPlatform, AdsAdapter } from "./types.js";

const GOOGLE_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999-888-7777",
};

const META_ENV = {
  META_ADS_ACCESS_TOKEN: "access-token",
  META_ADS_APP_SECRET: "app-secret",
};

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("createAdsAdapterFromEnv", () => {
  it("falls back to the mock when nothing is configured", () => {
    expect(createAdsAdapterFromEnv(env({})).name).toBe("mock");
  });

  it("builds the real Google adapter when every Google variable is set", () => {
    expect(createAdsAdapterFromEnv(env(GOOGLE_ENV)).name).toBe("google");
  });

  it("builds the real Meta adapter when both Meta variables are set", () => {
    expect(createAdsAdapterFromEnv(env(META_ENV)).name).toBe("meta");
  });

  it("builds a multi-platform adapter when both are configured", () => {
    expect(createAdsAdapterFromEnv(env({ ...GOOGLE_ENV, ...META_ENV })).name).toBe("multi");
  });

  it("treats a half-set platform as unset rather than throwing at boot", () => {
    const partial: Record<string, string> = { ...GOOGLE_ENV };
    delete partial.GOOGLE_ADS_REFRESH_TOKEN;
    expect(createAdsAdapterFromEnv(env(partial)).name).toBe("mock");
  });

  it("treats a blank variable as unset", () => {
    expect(createAdsAdapterFromEnv(env({ ...META_ENV, META_ADS_ACCESS_TOKEN: "  " })).name).toBe("mock");
  });

  it("still keeps the mock's drop-date behaviour when it falls back", async () => {
    const ads = createAdsAdapterFromEnv(env({ MOCK_ADS_DROP_FROM: "2026-09-10" }));
    const before = await ads.fetchDailyMetrics("acct-1", "2026-09-09");
    const after = await ads.fetchDailyMetrics("acct-1", "2026-09-10");
    expect(after.roas).toBeLessThan(before.roas);
  });

  it("reports which platform each environment can build", () => {
    expect(hasGoogleAdsCredentials(env(GOOGLE_ENV))).toBe(true);
    expect(hasGoogleAdsCredentials(env(META_ENV))).toBe(false);
    expect(hasMetaAdsCredentials(env(META_ENV))).toBe(true);
    expect(hasMetaAdsCredentials(env(GOOGLE_ENV))).toBe(false);
  });
});

describe("createAdsAdapter", () => {
  it("is unchanged: still mock-only, whatever ADS_ADAPTER says", () => {
    expect(createAdsAdapter(env({})).name).toBe("mock");
    expect(createAdsAdapter(env({ ADS_ADAPTER: "google", ...GOOGLE_ENV })).name).toBe("mock");
  });
});

class RecordingAdapter implements AdsAdapter {
  readonly seen: { accountId: string; platform: AdPlatform | undefined }[] = [];

  constructor(readonly name: "google" | "meta") {}

  async listAccounts(): Promise<AdAccountSummary[]> {
    return [{ externalId: `${this.name}-1`, platform: this.name, name: this.name, currency: "GBP" }];
  }

  async fetchDailyMetrics(accountId: string, date: string, platform?: AdPlatform): Promise<AdDailyMetrics> {
    this.seen.push({ accountId, platform });
    return {
      date, spendPence: 1, impressions: 1, clicks: 1,
      conversions: 0, conversionValuePence: 0, cpcPence: 1, roas: 0,
    };
  }
}

describe("MultiPlatformAdsAdapter", () => {
  it("routes on the platform the caller passes", async () => {
    const google = new RecordingAdapter("google");
    const meta = new RecordingAdapter("meta");
    const ads = new MultiPlatformAdsAdapter({ google, meta });

    await ads.fetchDailyMetrics("1234567890123456", "2026-09-01", "google");
    expect(google.seen).toHaveLength(1);
    expect(meta.seen).toHaveLength(0);
  });

  it("falls back to the id shape when no platform is passed", async () => {
    const google = new RecordingAdapter("google");
    const meta = new RecordingAdapter("meta");
    const ads = new MultiPlatformAdsAdapter({ google, meta });

    await ads.fetchDailyMetrics("123-456-7890", "2026-09-01");
    await ads.fetchDailyMetrics("act_1234567890123456", "2026-09-01");
    expect(google.seen.map((call) => call.accountId)).toEqual(["123-456-7890"]);
    expect(meta.seen.map((call) => call.accountId)).toEqual(["act_1234567890123456"]);
  });

  it("lists both platforms' accounts", async () => {
    const ads = new MultiPlatformAdsAdapter({ google: new RecordingAdapter("google"), meta: new RecordingAdapter("meta") });
    expect((await ads.listAccounts()).map((account) => account.platform)).toEqual(["google", "meta"]);
  });
});

describe("inferPlatform", () => {
  it("reads a ten-digit id as Google and everything else as Meta", () => {
    expect(inferPlatform("1234567890")).toBe("google");
    expect(inferPlatform("123-456-7890")).toBe("google");
    expect(inferPlatform("act_1234567890")).toBe("meta");
    expect(inferPlatform("1234567890123456")).toBe("meta");
  });
});

describe("minor-unit conversion", () => {
  it("rounds micros half-up", () => {
    expect(microsToMinorUnits(0)).toBe(0);
    expect(microsToMinorUnits(4_999)).toBe(0);
    expect(microsToMinorUnits(5_000)).toBe(1);
    expect(microsToMinorUnits(12_345_678)).toBe(1235);
  });

  it("reads decimal strings without float drift", () => {
    // Number("0.145") * 100 is 14.499999999999998, which Math.round takes to 14.
    expect(decimalToMinorUnits("0.145")).toBe(15);
    expect(decimalToMinorUnits("1.005")).toBe(101);
    expect(decimalToMinorUnits("412.37")).toBe(41237);
    expect(decimalToMinorUnits("7")).toBe(700);
    expect(decimalToMinorUnits("")).toBe(0);
    expect(decimalToMinorUnits(undefined)).toBe(0);
  });
});
