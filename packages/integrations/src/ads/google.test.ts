import { describe, expect, it } from "vitest";
import { AdsApiError, AdsAuthError, AdsRateLimitError } from "./errors.js";
import { GOOGLE_ADS_API_VERSION, GoogleAdsAdapter, type GoogleAdsOptions } from "./google.js";
import { fetchStub, type StubReply } from "./stub-fetch.js";

const CREDENTIALS = {
  developerToken: "dev-token",
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  refreshToken: "1//refresh-token",
  loginCustomerId: "999-888-7777",
} as const;

const TOKEN_OK: StubReply = {
  body: { access_token: "ya29.access-token", expires_in: 3599, token_type: "Bearer" },
};

/** One day of account-level figures, in the exact shape searchStream returns:
 * an array of chunks, int64 fields as strings, floats as numbers. */
function metricsChunk(overrides: Record<string, unknown> = {}): unknown {
  return [
    {
      results: [
        {
          customer: { resourceName: "customers/1234567890", currencyCode: "GBP" },
          metrics: {
            costMicros: "12345678",
            impressions: "8421",
            clicks: "263",
            conversions: 14.5,
            conversionsValue: 1287.4,
            ...overrides,
          },
          segments: { date: "2026-09-01" },
        },
      ],
      fieldMask: "customer.currencyCode,segments.date,metrics.costMicros",
    },
  ];
}

function adapter(replies: StubReply[], options: Partial<GoogleAdsOptions> = {}) {
  const stub = fetchStub(replies);
  const ads = new GoogleAdsAdapter({ ...CREDENTIALS, ...options, fetch: stub.fetch, sleep: stub.sleep });
  return { ads, stub };
}

describe("GoogleAdsAdapter credentials", () => {
  it("refuses to construct without credentials", () => {
    expect(() => new GoogleAdsAdapter({})).toThrow(/credentials required/i);
  });

  it("names every missing credential, not just the first", () => {
    expect(() => new GoogleAdsAdapter({ developerToken: "dev" }))
      .toThrow(/clientId, clientSecret, refreshToken, loginCustomerId/);
  });
});

describe("GoogleAdsAdapter token refresh", () => {
  it("exchanges the refresh token before the first API call", async () => {
    const { ads, stub } = adapter([TOKEN_OK, { body: metricsChunk() }]);
    await ads.fetchDailyMetrics("123-456-7890", "2026-09-01");

    const token = stub.calls[0]!;
    expect(token.url).toBe("https://oauth2.googleapis.com/token");
    expect(token.method).toBe("POST");
    expect(token.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(token.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(CREDENTIALS.refreshToken);
    expect(form.get("client_id")).toBe(CREDENTIALS.clientId);
    expect(form.get("client_secret")).toBe(CREDENTIALS.clientSecret);
  });

  it("sends the access token, developer token and login customer id on the API call", async () => {
    const { ads, stub } = adapter([TOKEN_OK, { body: metricsChunk() }]);
    await ads.fetchDailyMetrics("123-456-7890", "2026-09-01");

    const search = stub.calls[1]!;
    expect(search.url).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:searchStream`,
    );
    expect(search.headers.authorization).toBe("Bearer ya29.access-token");
    expect(search.headers["developer-token"]).toBe("dev-token");
    // Dashes stripped: the header and the path both want bare digits.
    expect(search.headers["login-customer-id"]).toBe("9998887777");
    const query = (JSON.parse(search.body) as { query: string }).query;
    expect(query).toContain("FROM customer");
    expect(query).toContain("metrics.cost_micros");
    expect(query).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-01'");
  });

  it("reuses a cached access token across calls", async () => {
    const { ads, stub } = adapter([TOKEN_OK, { body: metricsChunk() }, { body: metricsChunk() }]);
    await ads.fetchDailyMetrics("1234567890", "2026-09-01");
    await ads.fetchDailyMetrics("1234567890", "2026-09-02");
    expect(stub.calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(1);
  });

  it("refreshes again once the token has expired", async () => {
    const { ads, stub } = adapter([
      { body: { access_token: "short-lived", expires_in: 1 } },
      { body: metricsChunk() },
      TOKEN_OK,
      { body: metricsChunk() },
    ]);
    await ads.fetchDailyMetrics("1234567890", "2026-09-01");
    await ads.fetchDailyMetrics("1234567890", "2026-09-02");
    expect(stub.calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(2);
  });

  it("types a revoked refresh token as an auth error", async () => {
    const { ads } = adapter([
      { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
    ]);
    await expect(ads.fetchDailyMetrics("1234567890", "2026-09-01")).rejects.toBeInstanceOf(AdsAuthError);
  });

  it("types a 200 with no access_token as an auth error rather than sending an empty bearer", async () => {
    const { ads } = adapter([{ body: { token_type: "Bearer" } }]);
    await expect(ads.fetchDailyMetrics("1234567890", "2026-09-01")).rejects.toThrow(/no access_token/);
  });
});

describe("GoogleAdsAdapter.fetchDailyMetrics", () => {
  it("maps a chunked searchStream response onto the daily snapshot", async () => {
    const { ads } = adapter([TOKEN_OK, { body: metricsChunk() }]);
    const metrics = await ads.fetchDailyMetrics("123-456-7890", "2026-09-01");

    expect(metrics).toEqual({
      date: "2026-09-01",
      // 12,345,678 micros is £12.345678, which is 1234.5678p — half-up to 1235.
      spendPence: 1235,
      impressions: 8421,
      clicks: 263,
      // metrics.conversions is a float; the snapshot column is an integer.
      conversions: 15,
      conversionValuePence: 128740,
      cpcPence: 1235 / 263,
      roas: 128740 / 1235,
      currency: "GBP",
    });
  });

  it("sums results across every chunk of the stream", async () => {
    const chunked = [
      { results: [{ metrics: { costMicros: "1000000", impressions: "100", clicks: "10", conversions: 1, conversionsValue: 10 } }] },
      { results: [{ metrics: { costMicros: "2000000", impressions: "200", clicks: "20", conversions: 2, conversionsValue: 20 } }] },
    ];
    const { ads } = adapter([TOKEN_OK, { body: chunked }]);
    const metrics = await ads.fetchDailyMetrics("1234567890", "2026-09-01");
    expect(metrics.spendPence).toBe(300);
    expect(metrics.impressions).toBe(300);
    expect(metrics.clicks).toBe(30);
    expect(metrics.conversions).toBe(3);
    expect(metrics.conversionValuePence).toBe(3000);
  });

  it("rounds micros half-up to whole minor units", async () => {
    const cases: [string, number][] = [["0", 0], ["4999", 0], ["5000", 1], ["10000", 1], ["999995000", 100000]];
    for (const [costMicros, expected] of cases) {
      const { ads } = adapter([TOKEN_OK, { body: metricsChunk({ costMicros }) }]);
      const metrics = await ads.fetchDailyMetrics("1234567890", "2026-09-01");
      expect(metrics.spendPence, `${costMicros} micros`).toBe(expected);
    }
  });

  it("reports a day with no delivery as a real zero, not a divide by zero", async () => {
    const { ads } = adapter([TOKEN_OK, { body: [{ fieldMask: "metrics.clicks" }] }]);
    const metrics = await ads.fetchDailyMetrics("1234567890", "2026-09-01");
    expect(metrics).toEqual({
      date: "2026-09-01", spendPence: 0, impressions: 0, clicks: 0,
      conversions: 0, conversionValuePence: 0, cpcPence: 0, roas: 0,
    });
  });

  it("refuses a date that is not an ISO calendar date before it reaches the GAQL", async () => {
    const { ads, stub } = adapter([]);
    await expect(ads.fetchDailyMetrics("1234567890", "2026-09-01' OR '1'='1")).rejects.toThrow(/ISO calendar date/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("GoogleAdsAdapter failures", () => {
  it("retries a 429 once and succeeds", async () => {
    const { ads, stub } = adapter([
      TOKEN_OK,
      { status: 429, body: { error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "2" } },
      { body: metricsChunk() },
    ]);
    const metrics = await ads.fetchDailyMetrics("1234567890", "2026-09-01");
    expect(metrics.spendPence).toBe(1235);
    expect(stub.slept).toEqual([2000]);
    expect(stub.remaining()).toBe(0);
  });

  it("gives up after one retry and types the failure as a rate limit", async () => {
    const rateLimited: StubReply = {
      status: 429,
      body: { error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" } },
    };
    const { ads, stub } = adapter([TOKEN_OK, rateLimited, rateLimited]);
    await expect(ads.fetchDailyMetrics("1234567890", "2026-09-01")).rejects.toBeInstanceOf(AdsRateLimitError);
    // One retry, not a loop.
    expect(stub.slept).toHaveLength(1);
  });

  it("does not retry a 400, which no amount of waiting fixes", async () => {
    const { ads, stub } = adapter([
      TOKEN_OK,
      { status: 400, body: [{ error: { code: 400, message: "Unrecognized field in the query", status: "INVALID_ARGUMENT" } }] },
    ]);
    await expect(ads.fetchDailyMetrics("1234567890", "2026-09-01")).rejects.toThrow(/Unrecognized field/);
    expect(stub.slept).toHaveLength(0);
  });

  it("types 401 and 403 as auth errors", async () => {
    for (const status of [401, 403]) {
      const { ads } = adapter([
        TOKEN_OK,
        { status, body: { error: { code: status, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } },
      ]);
      await expect(ads.fetchDailyMetrics("1234567890", "2026-09-01")).rejects.toBeInstanceOf(AdsAuthError);
    }
  });

  it("drops the cached token on a 401 so the next call re-refreshes", async () => {
    const { ads, stub } = adapter([
      TOKEN_OK,
      { status: 401, body: { error: { code: 401, message: "Request had invalid authentication credentials" } } },
      TOKEN_OK,
      { body: metricsChunk() },
    ]);
    await expect(ads.fetchDailyMetrics("1234567890", "2026-09-01")).rejects.toBeInstanceOf(AdsAuthError);
    await ads.fetchDailyMetrics("1234567890", "2026-09-02");
    expect(stub.calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(2);
  });

  it("reports a body that is not JSON rather than pretending the day was empty", async () => {
    const { ads } = adapter([TOKEN_OK, { body: "<html>502 Bad Gateway</html>" }]);
    const error = await ads.fetchDailyMetrics("1234567890", "2026-09-01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdsApiError);
    expect((error as Error).message).toMatch(/not JSON/);
  });
});

describe("GoogleAdsAdapter.listAccounts", () => {
  it("enumerates the manager account's non-manager children", async () => {
    const { ads, stub } = adapter([
      TOKEN_OK,
      {
        body: [
          {
            results: [
              { customerClient: { id: "1234567890", descriptiveName: "Grays CabLine", currencyCode: "gbp", manager: false } },
              { customerClient: { id: "2233445566", currencyCode: "USD", manager: false } },
            ],
          },
        ],
      },
    ]);
    expect(await ads.listAccounts()).toEqual([
      { externalId: "1234567890", platform: "google", name: "Grays CabLine", currency: "GBP" },
      // No descriptive name — the id is a better label than an empty string.
      { externalId: "2233445566", platform: "google", name: "2233445566", currency: "USD" },
    ]);
    const query = (JSON.parse(stub.calls[1]!.body) as { query: string }).query;
    expect(query).toContain("FROM customer_client");
    expect(query).toContain("customer_client.manager = FALSE");
    expect(stub.calls[1]!.url).toContain("/customers/9998887777/");
  });
});

describe("GoogleAdsAdapter fetchCampaignMetrics", () => {
  it("queries FROM campaign and folds the rows by campaign id", async () => {
    const chunk = [
      {
        results: [
          {
            campaign: { id: "111", name: "spring-offer" },
            customer: { currencyCode: "GBP" },
            metrics: { costMicros: "4000000", impressions: "3000", clicks: "100", conversions: 4, conversionsValue: 250.5 },
            segments: { date: "2026-09-01" },
          },
          {
            campaign: { id: "222", name: "brand-search" },
            customer: { currencyCode: "GBP" },
            metrics: { costMicros: "1500000", impressions: "1000", clicks: "40", conversions: 1.5, conversionsValue: 90 },
            segments: { date: "2026-09-01" },
          },
          // The same campaign again, as a further segment would return it.
          {
            campaign: { id: "111", name: "spring-offer" },
            customer: { currencyCode: "GBP" },
            metrics: { costMicros: "1000000", impressions: "500", clicks: "20", conversions: 0.5, conversionsValue: 30 },
            segments: { date: "2026-09-01" },
          },
        ],
      },
    ];
    const { ads, stub } = adapter([TOKEN_OK, { body: chunk }]);
    const rows = await ads.fetchCampaignMetrics("123-456-7890", "2026-09-01");

    expect(JSON.parse(stub.calls[1]!.body).query).toContain("FROM campaign WHERE segments.date BETWEEN '2026-09-01'");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      campaignExternalId: "111", campaignName: "spring-offer", spendPence: 500, impressions: 3500, clicks: 120, currency: "GBP",
    });
    // Fractional conversions are summed before they are rounded: 4 + 0.5 → 5.
    expect(rows[0]!.conversions).toBe(5);
    expect(rows[1]).toMatchObject({ campaignExternalId: "222", spendPence: 150, conversionValuePence: 9000 });
  });

  it("returns nothing for a day nothing delivered, rather than a zero-spend campaign", async () => {
    const { ads } = adapter([TOKEN_OK, { body: [{ results: [] }] }]);
    expect(await ads.fetchCampaignMetrics("1234567890", "2026-09-01")).toEqual([]);
  });
});
