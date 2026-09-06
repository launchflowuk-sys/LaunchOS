import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchStub } from "../ads/stub-fetch.js";
import { SocialAuthError, SocialRateLimitError } from "./errors.js";
import { lookupInstagramForPage } from "./instagram-lookup.js";
import { META_GRAPH_API_VERSION } from "./meta.js";

const TOKEN = "EAAG-system-user-token";
const APP_SECRET = "app-secret";
const env = { META_ADS_ACCESS_TOKEN: TOKEN, META_ADS_APP_SECRET: APP_SECRET } as NodeJS.ProcessEnv;
const proof = createHmac("sha256", APP_SECRET).update(TOKEN).digest("hex");
const PAGE_ID = "101234567890123";
const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

describe("lookupInstagramForPage", () => {
  it("asks Graph for the page's instagram_business_account with the system-user token and its proof", async () => {
    const stub = fetchStub([{ body: { instagram_business_account: { id: "17841400000000000", username: "grayscabline" }, id: PAGE_ID } }]);

    const account = await lookupInstagramForPage(PAGE_ID, env, { fetch: stub.fetch, sleep: stub.sleep });

    expect(account).toEqual({ id: "17841400000000000", username: "grayscabline" });
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`${GRAPH}/${PAGE_ID}?fields=instagram_business_account{id,username}&appsecret_proof=${proof}`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toMatch(/access_token=/);
  });

  it("returns null for a page with no connected Instagram account, and keeps the id when the username is withheld", async () => {
    const none = fetchStub([{ body: { id: PAGE_ID } }]);
    expect(await lookupInstagramForPage(PAGE_ID, env, { fetch: none.fetch, sleep: none.sleep })).toBeNull();

    const idOnly = fetchStub([{ body: { instagram_business_account: { id: 17841400000000000 } } }]);
    expect(await lookupInstagramForPage(PAGE_ID, env, { fetch: idOnly.fetch, sleep: idOnly.sleep })).toEqual({ id: "17841400000000000", username: null });
  });

  it("honours META_ADS_API_VERSION and an injected endpoint, and trims the page id", async () => {
    const stub = fetchStub([{ body: { id: PAGE_ID } }]);
    await lookupInstagramForPage(` ${PAGE_ID} `, { ...env, META_ADS_API_VERSION: "v99.0" }, {
      fetch: stub.fetch, sleep: stub.sleep, endpoint: "https://graph.test/",
    });
    expect(stub.calls[0]!.url).toBe(`https://graph.test/v99.0/${PAGE_ID}?fields=instagram_business_account{id,username}&appsecret_proof=${proof}`);
  });

  it("throws an auth error before any call when the Meta keys are not set — that is not 'no Instagram account'", async () => {
    const stub = fetchStub([]);
    await expect(lookupInstagramForPage(PAGE_ID, {} as NodeJS.ProcessEnv, { fetch: stub.fetch })).rejects.toBeInstanceOf(SocialAuthError);
    await expect(lookupInstagramForPage(PAGE_ID, { META_ADS_ACCESS_TOKEN: TOKEN, META_ADS_APP_SECRET: " " } as NodeJS.ProcessEnv, { fetch: stub.fetch }))
      .rejects.toThrow(/META_ADS_ACCESS_TOKEN and META_ADS_APP_SECRET are not set/);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a page id that is not a Graph id rather than sending it as a path", async () => {
    const stub = fetchStub([]);
    await expect(lookupInstagramForPage("../me", env, { fetch: stub.fetch })).rejects.toThrow(/not a Graph id/);
    expect(stub.calls).toHaveLength(0);
  });

  it("maps a Graph error envelope to the social error family, retrying a throttle once", async () => {
    const auth = fetchStub([{ status: 400, body: { error: { message: "Invalid OAuth access token.", code: 190 } } }]);
    await expect(lookupInstagramForPage(PAGE_ID, env, { fetch: auth.fetch, sleep: auth.sleep })).rejects.toBeInstanceOf(SocialAuthError);

    const throttled = fetchStub([
      { status: 400, body: { error: { message: "Too many calls", code: 4 } } },
      { status: 400, body: { error: { message: "Too many calls", code: 4 } } },
    ]);
    await expect(lookupInstagramForPage(PAGE_ID, env, { fetch: throttled.fetch, sleep: throttled.sleep })).rejects.toBeInstanceOf(SocialRateLimitError);
    expect(throttled.calls).toHaveLength(2);

    // Graph occasionally answers 200 with an error envelope.
    const envelope = fetchStub([{ status: 200, body: { error: { message: "Unsupported get request.", code: 100 } } }]);
    await expect(lookupInstagramForPage(PAGE_ID, env, { fetch: envelope.fetch, sleep: envelope.sleep })).rejects.toThrow(/Unsupported get request/);
  });
});
