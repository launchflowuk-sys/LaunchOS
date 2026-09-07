import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServiceAccountKey, ServiceAccountTokenSource, SEARCH_CONSOLE_SCOPE } from "./auth.js";
import { GoogleSearchConsoleAdapter } from "./google.js";
import { MockSearchConsoleAdapter } from "./mock.js";
import { createSearchConsoleFromEnv, hasSearchConsoleCredentials } from "./index.js";
import { SearchConsoleAuthError, SearchConsoleError, SearchConsoleQuotaError } from "./errors.js";
import { createHttpRuntime } from "../ads/http.js";

const TOKEN_URL = "https://token.test/token";
const ANALYTICS_BASE = "https://gsc.test/webmasters/v3";
const INSPECTION_URL = "https://gsc.test/v1/urlInspection/index:inspect";
const SITE = "https://launchflow.co.uk/";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CREDENTIALS = { clientEmail: "launchos@project.iam.gserviceaccount.com", privateKey: PEM };

interface Call {
  readonly url: string;
  readonly body: string;
  readonly authorization: string;
}

interface Canned {
  readonly status: number;
  readonly body: unknown;
}

/** A fetch that records what it was asked and replies from a queue, falling back to the last reply. */
function stubFetch(replies: readonly Canned[]) {
  const calls: Call[] = [];
  let index = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authorization: headers.get("authorization") ?? "",
    });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) throw new Error("stubFetch was given no replies");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const TOKEN_OK: Canned = { status: 200, body: { access_token: "at-1", expires_in: 3600 } };

/** Indexing under `noUncheckedIndexedAccess`: a missing call is the test's own bug, so say so rather than assert past it. */
function callAt(calls: readonly Call[], index: number): Call {
  const call = calls[index];
  if (call === undefined) throw new Error(`expected a request at index ${index}, saw ${calls.length}`);
  return call;
}

function adapterWith(replies: readonly Canned[]) {
  const stub = stubFetch(replies);
  const adapter = new GoogleSearchConsoleAdapter(CREDENTIALS, {
    fetch: stub.fetch,
    sleep: async () => {},
    retries: 0,
    tokenUrl: TOKEN_URL,
    analyticsBase: ANALYTICS_BASE,
    inspectionUrl: INSPECTION_URL,
  });
  return { adapter, calls: stub.calls };
}

describe("parseServiceAccountKey", () => {
  const key = { client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };

  it("reads the downloaded key file as raw JSON", () => {
    const parsed = parseServiceAccountKey(JSON.stringify(key));
    expect(parsed.clientEmail).toBe("a@b.iam.gserviceaccount.com");
    expect(parsed.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("reads the same file base64-encoded, which is how it survives a deploy", () => {
    const encoded = Buffer.from(JSON.stringify(key), "utf8").toString("base64");
    expect(parseServiceAccountKey(encoded)).toEqual(parseServiceAccountKey(JSON.stringify(key)));
  });

  it("repairs a PEM whose newlines arrived as two literal characters", () => {
    const broken = JSON.stringify({ ...key, private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n" });
    expect(parseServiceAccountKey(broken).privateKey).toBe(key.private_key);
  });

  it("tolerates surrounding whitespace from a copy and paste", () => {
    expect(parseServiceAccountKey(`  ${JSON.stringify(key)}\n`).clientEmail).toBe(key.client_email);
  });

  it.each([
    ["an empty value", ""],
    ["something that is not a key at all", "not-a-key"],
    ["JSON without the two fields that matter", JSON.stringify({ type: "service_account" })],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseServiceAccountKey(raw)).toThrow(SearchConsoleError);
  });
});

describe("ServiceAccountTokenSource", () => {
  function sourceWith(replies: readonly Canned[]) {
    const stub = stubFetch(replies);
    const http = createHttpRuntime({ fetch: stub.fetch, sleep: async () => {}, retries: 0 });
    return { source: new ServiceAccountTokenSource(CREDENTIALS, http, undefined, TOKEN_URL), calls: stub.calls };
  }

  it("signs an assertion the public key verifies, claiming the read-only scope", async () => {
    const { source, calls } = sourceWith([TOKEN_OK]);
    await source.accessToken();

    const assertion = new URLSearchParams(callAt(calls, 0).body).get("assertion") ?? "";
    const parts = assertion.split(".");
    expect(parts).toHaveLength(3);
    const [header, claims, signature] = parts as [string, string, string];
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .end()
      .verify(publicKey, Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))).toMatchObject({
      iss: CREDENTIALS.clientEmail,
      scope: SEARCH_CONSOLE_SCOPE,
      aud: TOKEN_URL,
    });
  });

  it("uses the JWT bearer grant rather than a refresh token", async () => {
    const { source, calls } = sourceWith([TOKEN_OK]);
    await source.accessToken();
    const body = new URLSearchParams(callAt(calls, 0).body);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("refresh_token")).toBeNull();
  });

  it("caches, so a batch of calls mints one token", async () => {
    const { source, calls } = sourceWith([TOKEN_OK]);
    await source.accessToken();
    await source.accessToken();
    expect(calls).toHaveLength(1);
  });

  it("single-flights concurrent callers", async () => {
    const { source, calls } = sourceWith([TOKEN_OK]);
    await Promise.all([source.accessToken(), source.accessToken(), source.accessToken()]);
    expect(calls).toHaveLength(1);
  });

  it("mints again after forget(), so a revoked token is not replayed forever", async () => {
    const { source, calls } = sourceWith([TOKEN_OK]);
    await source.accessToken();
    source.forget();
    await source.accessToken();
    expect(calls).toHaveLength(2);
  });

  it("does not cache a token whose lifetime is shorter than the refresh skew", async () => {
    const { source, calls } = sourceWith([{ status: 200, body: { access_token: "at-1", expires_in: 10 } }]);
    await source.accessToken();
    await source.accessToken();
    expect(calls).toHaveLength(2);
  });

  it("treats a 4xx from the token endpoint as a credential problem, not a blip", async () => {
    const { source } = sourceWith([{ status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT" } }]);
    await expect(source.accessToken()).rejects.toBeInstanceOf(SearchConsoleAuthError);
  });

  it("explains a malformed private key instead of leaking an OpenSSL code", async () => {
    const stub = stubFetch([TOKEN_OK]);
    const http = createHttpRuntime({ fetch: stub.fetch, sleep: async () => {}, retries: 0 });
    const source = new ServiceAccountTokenSource({ clientEmail: "a@b.com", privateKey: "not a pem" }, http, undefined, TOKEN_URL);
    await expect(source.accessToken()).rejects.toThrow(/malformed/i);
  });
});

describe("GoogleSearchConsoleAdapter.searchAnalytics", () => {
  const rows = { rows: [{ keys: ["plumber grays"], clicks: 12, impressions: 300, ctr: 0.04, position: 8.2 }] };

  it("encodes the property into the path, so the property is found at all", async () => {
    const { adapter, calls } = adapterWith([TOKEN_OK, { status: 200, body: rows }]);
    await adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["query"] });
    expect(callAt(calls, 1).url).toBe(`${ANALYTICS_BASE}/sites/https%3A%2F%2Flaunchflow.co.uk%2F/searchAnalytics/query`);
  });

  it("sends the window and grouping, and bearers the minted token", async () => {
    const { adapter, calls } = adapterWith([TOKEN_OK, { status: 200, body: rows }]);
    await adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["query"], rowLimit: 10 });
    expect(JSON.parse(callAt(calls, 1).body)).toEqual({ startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["query"], rowLimit: 10 });
    expect(callAt(calls, 1).authorization).toBe("Bearer at-1");
  });

  it("clamps a row limit above Google's ceiling rather than being refused", async () => {
    const { adapter, calls } = adapterWith([TOKEN_OK, { status: 200, body: rows }]);
    await adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["query"], rowLimit: 1_000_000 });
    expect(JSON.parse(callAt(calls, 1).body).rowLimit).toBe(25_000);
  });

  it("returns the rows as they came", async () => {
    const { adapter } = adapterWith([TOKEN_OK, { status: 200, body: rows }]);
    const result = await adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["query"] });
    expect(result).toEqual([{ keys: ["plumber grays"], clicks: 12, impressions: 300, ctr: 0.04, position: 8.2 }]);
  });

  it("treats a property with no impressions as empty, not as broken", async () => {
    const { adapter } = adapterWith([TOKEN_OK, { status: 200, body: {} }]);
    await expect(adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["date"] })).resolves.toEqual([]);
  });

  it("names the likely cause when the service account is not on the property", async () => {
    const { adapter } = adapterWith([TOKEN_OK, { status: 403, body: { error: { message: "User does not have sufficient permission for site" } } }]);
    const error = await adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["date"] }).catch((e) => e);
    expect(error).toBeInstanceOf(SearchConsoleAuthError);
    expect(error.code).toBe("auth");
  });

  it("separates a spent quota from an ordinary failure", async () => {
    const { adapter } = adapterWith([TOKEN_OK, { status: 429, body: { error: { message: "Quota exceeded" } } }]);
    await expect(adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["date"] }))
      .rejects.toBeInstanceOf(SearchConsoleQuotaError);
  });

  it("re-mints once on a 401 rather than replaying a dead token for the life of the process", async () => {
    const stub = stubFetch([TOKEN_OK, { status: 401, body: {} }, { status: 200, body: { access_token: "at-2", expires_in: 3600 } }, { status: 200, body: rows }]);
    const adapter = new GoogleSearchConsoleAdapter(CREDENTIALS, {
      fetch: stub.fetch, sleep: async () => {}, retries: 0, tokenUrl: TOKEN_URL, analyticsBase: ANALYTICS_BASE, inspectionUrl: INSPECTION_URL,
    });

    await expect(adapter.searchAnalytics(SITE, { startDate: "2026-08-01", endDate: "2026-08-31", dimensions: ["query"] })).resolves.toHaveLength(1);
    expect(stub.calls.at(-1)?.authorization).toBe("Bearer at-2");
  });
});

describe("GoogleSearchConsoleAdapter.inspectUrl", () => {
  it("reads the index status out of Google's nesting", async () => {
    const body = {
      inspectionResult: {
        indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", robotsTxtState: "ALLOWED", lastCrawlTime: "2026-09-01T10:00:00Z" },
      },
    };
    const { adapter, calls } = adapterWith([TOKEN_OK, { status: 200, body }]);
    const result = await adapter.inspectUrl(SITE, "https://launchflow.co.uk/pricing");

    expect(JSON.parse(callAt(calls, 1).body)).toEqual({ inspectionUrl: "https://launchflow.co.uk/pricing", siteUrl: SITE });
    expect(result).toEqual({
      url: "https://launchflow.co.uk/pricing",
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      lastCrawlTime: "2026-09-01T10:00:00Z",
    });
  });

  it("survives a reply with no index status, which is what an unknown URL gives", async () => {
    const { adapter } = adapterWith([TOKEN_OK, { status: 200, body: { inspectionResult: {} } }]);
    const result = await adapter.inspectUrl(SITE, "https://launchflow.co.uk/gone");
    expect(result.verdict).toBe("VERDICT_UNSPECIFIED");
    expect(result.lastCrawlTime).toBeNull();
  });
});

describe("MockSearchConsoleAdapter", () => {
  const mock = new MockSearchConsoleAdapter();
  const august = { startDate: "2026-08-01", endDate: "2026-08-07", dimensions: ["date"] } as const;

  it("says it is not live, so nothing renders invented traffic as real", () => {
    expect(mock.live).toBe(false);
  });

  it("gives the same answer twice, so a screen does not reshuffle on refresh", async () => {
    expect(await mock.searchAnalytics(SITE, august)).toEqual(await mock.searchAnalytics(SITE, august));
  });

  it("gives different properties different numbers", async () => {
    const ours = await mock.searchAnalytics(SITE, august);
    const theirs = await mock.searchAnalytics("https://amafacilities.co.uk/", august);
    expect(ours).not.toEqual(theirs);
  });

  it("returns one row per day when grouped by date", async () => {
    expect(await mock.searchAnalytics(SITE, august)).toHaveLength(7);
  });

  it("returns terms best-first when grouped by query, the way Google orders them", async () => {
    const rows = await mock.searchAnalytics(SITE, { ...august, dimensions: ["query"] });
    const clicks = rows.map((row) => row.clicks);
    expect(clicks).toEqual([...clicks].sort((a, b) => b - a));
  });

  it("gives no rows for a window that runs backwards rather than looping", async () => {
    expect(await mock.searchAnalytics(SITE, { startDate: "2026-08-31", endDate: "2026-08-01", dimensions: ["date"] })).toEqual([]);
  });

  it("keeps ctr consistent with its own clicks and impressions", async () => {
    for (const row of await mock.searchAnalytics(SITE, august)) {
      expect(row.ctr).toBeCloseTo(row.clicks / row.impressions, 10);
      expect(row.position).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("createSearchConsoleFromEnv", () => {
  const key = Buffer.from(JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: PEM }), "utf8").toString("base64");

  it("builds the mock when no key is set", () => {
    expect(createSearchConsoleFromEnv({}).live).toBe(false);
  });

  it("treats a blank key as unset, as every other factory does", () => {
    expect(hasSearchConsoleCredentials({ GSC_SERVICE_ACCOUNT_JSON: "   " })).toBe(false);
    expect(createSearchConsoleFromEnv({ GSC_SERVICE_ACCOUNT_JSON: "   " }).live).toBe(false);
  });

  it("builds the real adapter when the key is there", () => {
    const adapter = createSearchConsoleFromEnv({ GSC_SERVICE_ACCOUNT_JSON: key });
    expect(adapter.live).toBe(true);
    expect(adapter.name).toBe("google-search-console");
  });

  it("throws on a broken key rather than quietly serving invented numbers", () => {
    expect(() => createSearchConsoleFromEnv({ GSC_SERVICE_ACCOUNT_JSON: "bm90LWpzb24=" })).toThrow(SearchConsoleError);
  });
});
