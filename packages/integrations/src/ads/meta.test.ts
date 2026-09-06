import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdsApiError, AdsAuthError, AdsRateLimitError } from "./errors.js";
import { META_GRAPH_API_VERSION, MetaAdsAdapter, type MetaAdsOptions } from "./meta.js";
import { fetchStub, type StubReply } from "./stub-fetch.js";

const ACCESS_TOKEN = "EAAG-system-user-token";
const APP_SECRET = "app-secret";
const EXPECTED_PROOF = createHmac("sha256", APP_SECRET).update(ACCESS_TOKEN).digest("hex");
const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

/** One day of account-level insights, in Graph's own shape: every number a
 * string, conversions buried in an `actions` array of overlapping roll-ups. */
function insightsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_currency: "GBP",
    spend: "412.37",
    impressions: "50219",
    clicks: "1104",
    actions: [
      { action_type: "link_click", value: "1104" },
      { action_type: "landing_page_view", value: "902" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "23" },
      { action_type: "offsite_conversion.fb_pixel_lead", value: "9" },
      // Roll-ups over the same events. Counting these too would treble the number.
      { action_type: "purchase", value: "23" },
      { action_type: "omni_purchase", value: "23" },
    ],
    action_values: [
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "1874.55" },
      { action_type: "omni_purchase", value: "1874.55" },
    ],
    date_start: "2026-09-01",
    date_stop: "2026-09-01",
    ...overrides,
  };
}

function adapter(replies: StubReply[], options: Partial<MetaAdsOptions> = {}) {
  const stub = fetchStub(replies);
  const ads = new MetaAdsAdapter({
    accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, ...options, fetch: stub.fetch, sleep: stub.sleep,
  });
  return { ads, stub };
}

describe("MetaAdsAdapter credentials", () => {
  it("refuses to construct without credentials", () => {
    expect(() => new MetaAdsAdapter({})).toThrow(/credentials required/i);
  });

  it("still refuses when only the token is supplied — appsecret_proof needs the secret", () => {
    expect(() => new MetaAdsAdapter({ accessToken: ACCESS_TOKEN })).toThrow(/appSecret/);
  });
});

describe("MetaAdsAdapter request shape", () => {
  it("asks for one day of account-level insights, signed with appsecret_proof", async () => {
    const { ads, stub } = adapter([{ body: { data: [insightsRow()] } }]);
    await ads.fetchDailyMetrics("act_1234567890123456", "2026-09-01");

    const call = stub.calls[0]!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(`${GRAPH}/act_1234567890123456/insights`);
    expect(url.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(url.searchParams.get("time_range") ?? "{}")).toEqual({ since: "2026-09-01", until: "2026-09-01" });
    expect(url.searchParams.get("fields")).toBe("account_currency,spend,impressions,clicks,actions,action_values");
    expect(url.searchParams.get("appsecret_proof")).toBe(EXPECTED_PROOF);
    // The token is a header, never a query parameter: URLs end up in logs.
    expect(url.searchParams.get("access_token")).toBeNull();
    expect(call.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("accepts a bare numeric account id as well as act_", async () => {
    const { ads, stub } = adapter([{ body: { data: [] } }]);
    await ads.fetchDailyMetrics("1234567890123456", "2026-09-01");
    expect(stub.calls[0]!.url).toContain("/act_1234567890123456/insights");
  });

  it("refuses a date that is not an ISO calendar date", async () => {
    const { ads, stub } = adapter([]);
    await expect(ads.fetchDailyMetrics("act_1", "01/09/2026")).rejects.toThrow(/ISO calendar date/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("MetaAdsAdapter.fetchDailyMetrics", () => {
  it("maps an insights row onto the daily snapshot", async () => {
    const { ads } = adapter([{ body: { data: [insightsRow()] } }]);
    const metrics = await ads.fetchDailyMetrics("act_1234567890123456", "2026-09-01");

    expect(metrics).toEqual({
      date: "2026-09-01",
      spendPence: 41237,
      impressions: 50219,
      clicks: 1104,
      // 23 pixel purchases + 9 pixel leads. The `purchase` / `omni_purchase`
      // roll-ups describe the same 23 sales and are deliberately not added.
      conversions: 32,
      conversionValuePence: 187455,
      cpcPence: 41237 / 1104,
      roas: 187455 / 41237,
      currency: "GBP",
    });
  });

  it("parses spend from the decimal string without float drift", async () => {
    const cases: [string, number][] = [["0", 0], ["0.01", 1], ["0.145", 15], ["1.005", 101], ["9999.99", 999999]];
    for (const [spend, expected] of cases) {
      const { ads } = adapter([{ body: { data: [insightsRow({ spend })] } }]);
      const metrics = await ads.fetchDailyMetrics("act_1", "2026-09-01");
      expect(metrics.spendPence, `spend ${spend}`).toBe(expected);
    }
  });

  it("counts only the configured conversion action types", async () => {
    const { ads } = adapter([{ body: { data: [insightsRow()] } }], {
      conversionActionTypes: ["offsite_conversion.fb_pixel_purchase"],
    });
    const metrics = await ads.fetchDailyMetrics("act_1", "2026-09-01");
    expect(metrics.conversions).toBe(23);
  });

  it("reports zeros for a day Meta returns no rows for", async () => {
    const { ads } = adapter([{ body: { data: [] } }]);
    expect(await ads.fetchDailyMetrics("act_1", "2026-09-01")).toEqual({
      date: "2026-09-01", spendPence: 0, impressions: 0, clicks: 0,
      conversions: 0, conversionValuePence: 0, cpcPence: 0, roas: 0,
    });
  });

  it("treats a row with no actions array as zero conversions", async () => {
    const { ads } = adapter([{ body: { data: [insightsRow({ actions: undefined, action_values: undefined })] } }]);
    const metrics = await ads.fetchDailyMetrics("act_1", "2026-09-01");
    expect(metrics.conversions).toBe(0);
    expect(metrics.conversionValuePence).toBe(0);
    expect(metrics.spendPence).toBe(41237);
  });
});

describe("MetaAdsAdapter paging", () => {
  it("follows paging.next and accumulates every page", async () => {
    const nextUrl = `${GRAPH}/act_1/insights?after=cursor-2&appsecret_proof=${EXPECTED_PROOF}`;
    const { ads, stub } = adapter([
      { body: { data: [insightsRow({ spend: "10.00", clicks: "10", impressions: "100" })], paging: { next: nextUrl } } },
      { body: { data: [insightsRow({ spend: "5.50", clicks: "5", impressions: "50" })], paging: {} } },
    ]);
    const metrics = await ads.fetchDailyMetrics("act_1", "2026-09-01");
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.url).toBe(nextUrl);
    expect(stub.calls[1]!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(metrics.spendPence).toBe(1550);
    expect(metrics.clicks).toBe(15);
    expect(metrics.impressions).toBe(150);
  });

  it("adds appsecret_proof to a cursor URL that arrives without one", async () => {
    const { ads, stub } = adapter([
      { body: { data: [], paging: { next: `${GRAPH}/act_1/insights?after=cursor-2` } } },
      { body: { data: [] } },
    ]);
    await ads.fetchDailyMetrics("act_1", "2026-09-01");
    expect(stub.calls[1]!.url).toContain(`appsecret_proof=${EXPECTED_PROOF}`);
  });

  it("refuses to follow a cursor pointing at another host", async () => {
    // The token travels as a header on whatever URL this follows, so a
    // response body must not be able to choose where it is sent.
    const { ads, stub } = adapter([
      { body: { data: [insightsRow()], paging: { next: "https://evil.example.com/collect?after=1" } } },
    ]);
    const metrics = await ads.fetchDailyMetrics("act_1", "2026-09-01");
    expect(stub.calls).toHaveLength(1);
    expect(metrics.spendPence).toBe(41237);
  });
});

describe("MetaAdsAdapter failures", () => {
  it("retries a 429 once and succeeds", async () => {
    const { ads, stub } = adapter([
      { status: 429, body: { error: { message: "User request limit reached", code: 17 } }, headers: { "retry-after": "3" } },
      { body: { data: [insightsRow()] } },
    ]);
    const metrics = await ads.fetchDailyMetrics("act_1", "2026-09-01");
    expect(metrics.spendPence).toBe(41237);
    expect(stub.slept).toEqual([3000]);
  });

  it("retries Meta's HTTP 200-shaped throttle, which arrives as a 400 with code 4", async () => {
    const throttled: StubReply = {
      status: 400,
      body: { error: { message: "Application request limit reached", code: 4, type: "OAuthException" } },
    };
    const { ads, stub } = adapter([throttled, { body: { data: [insightsRow()] } }]);
    await ads.fetchDailyMetrics("act_1", "2026-09-01");
    expect(stub.slept).toHaveLength(1);
  });

  it("gives up after one retry and types the failure as a rate limit", async () => {
    const throttled: StubReply = { status: 400, body: { error: { message: "limit reached", code: 4 } } };
    const { ads, stub } = adapter([throttled, throttled]);
    await expect(ads.fetchDailyMetrics("act_1", "2026-09-01")).rejects.toBeInstanceOf(AdsRateLimitError);
    expect(stub.slept).toHaveLength(1);
  });

  it("types an expired access token as an auth error and does not retry it", async () => {
    const { ads, stub } = adapter([
      {
        status: 400,
        body: { error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } },
      },
    ]);
    const error = await ads.fetchDailyMetrics("act_1", "2026-09-01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdsAuthError);
    expect((error as Error).message).toMatch(/Session has expired/);
    expect(stub.slept).toHaveLength(0);
  });

  it("types an unknown failure as a plain api error", async () => {
    const { ads } = adapter([
      { status: 400, body: { error: { message: "(#100) Unsupported get request", code: 100 } } },
    ]);
    const error = await ads.fetchDailyMetrics("act_1", "2026-09-01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdsApiError);
    expect(error).not.toBeInstanceOf(AdsAuthError);
    expect(error).not.toBeInstanceOf(AdsRateLimitError);
  });

  it("throws on an error envelope that arrives with HTTP 200", async () => {
    const { ads } = adapter([{ status: 200, body: { error: { message: "Session has expired", code: 190 } } }]);
    await expect(ads.fetchDailyMetrics("act_1", "2026-09-01")).rejects.toBeInstanceOf(AdsAuthError);
  });
});

describe("MetaAdsAdapter.listAccounts", () => {
  it("pages through every ad account the token can see", async () => {
    const nextUrl = `${GRAPH}/me/adaccounts?after=cursor-2`;
    const { ads, stub } = adapter([
      {
        body: {
          data: [{ account_id: "1234567890123456", name: "Star Cat Grooming", currency: "gbp" }],
          paging: { next: nextUrl },
        },
      },
      { body: { data: [{ account_id: "6543210987654321", currency: "EUR" }] } },
    ]);
    expect(await ads.listAccounts()).toEqual([
      { externalId: "1234567890123456", platform: "meta", name: "Star Cat Grooming", currency: "GBP" },
      { externalId: "6543210987654321", platform: "meta", name: "act_6543210987654321", currency: "EUR" },
    ]);
    expect(stub.calls[0]!.url).toContain("/me/adaccounts?fields=account_id,name,currency");
  });
});

describe("MetaAdsAdapter fetchCampaignMetrics", () => {
  it("asks for level=campaign and returns one row per campaign", async () => {
    const { ads, stub } = adapter([
      {
        body: {
          data: [
            {
              campaign_id: "3001", campaign_name: "spring-offer", account_currency: "GBP",
              spend: "40.00", impressions: "3000", clicks: "100",
              actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "6" }],
              action_values: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "300.00" }],
            },
            {
              campaign_id: "3002", campaign_name: "retargeting", account_currency: "GBP",
              spend: "12.50", impressions: "900", clicks: "35", actions: [], action_values: [],
            },
          ],
        },
      },
    ]);
    const rows = await ads.fetchCampaignMetrics("act_1234567890123456", "2026-09-01");

    expect(stub.calls[0]!.url).toContain("level=campaign");
    expect(stub.calls[0]!.url).toContain("campaign_id%2Ccampaign_name");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      campaignExternalId: "3001", campaignName: "spring-offer", spendPence: 4000, clicks: 100, conversions: 6,
      conversionValuePence: 30000, currency: "GBP",
    });
    expect(rows[1]).toMatchObject({ campaignExternalId: "3002", spendPence: 1250, conversions: 0 });
  });
});
