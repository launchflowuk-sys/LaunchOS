import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStub, type StubReply } from "../ads/stub-fetch.js";
import { SocialApiError, SocialAuthError, SocialInvalidMediaError, SocialRateLimitError } from "./errors.js";
import { GBP_ACCOUNTS_ENDPOINT, GBP_API_ENDPOINT, GBP_LOCATIONS_ENDPOINT, GbpPublisher, type GbpOptions } from "./gbp.js";
import { GOOGLE_OAUTH_TOKEN_URL } from "./gbp-oauth.js";

const LOCATION = "accounts/106000000000000000001/locations/12345678901234567890";
const POST_NAME = `${LOCATION}/localPosts/9876543210`;
const SEARCH_URL = "https://local.google.com/place?id=123&use=posts&lpsid=9876543210";

/** The refresh-token exchange every fresh publisher starts with. */
const tokenReply: StubReply = { body: { access_token: "ya29.first", expires_in: 3599, token_type: "Bearer" } };
const postReply: StubReply = { body: { name: POST_NAME, state: "LIVE", searchUrl: SEARCH_URL } };

function publisher(replies: StubReply[], options: Partial<GbpOptions> = {}) {
  const stub = fetchStub(replies);
  const social = new GbpPublisher({
    clientId: "client-id", clientSecret: "client-secret", refreshToken: "1//refresh", ...options, fetch: stub.fetch, sleep: stub.sleep,
  });
  return { social, stub };
}

const post = (overrides: Partial<Parameters<GbpPublisher["publish"]>[0]> = {}) => ({
  channel: "gbp" as const, externalId: LOCATION, text: "Airport runs from £45, fixed price. Book online.", ...overrides,
});

describe("GbpPublisher credentials", () => {
  it("refuses to construct without all three keys", () => {
    expect(() => new GbpPublisher({})).toThrow(/credentials required/i);
    expect(() => new GbpPublisher({ clientId: "a", clientSecret: "b" })).toThrow(/refreshToken/);
  });
});

describe("GbpPublisher token refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges the refresh token once and reuses the access token across publishes", async () => {
    const { social, stub } = publisher([tokenReply, postReply, postReply]);
    await social.publish(post());
    await social.publish(post({ text: "Second update" }));

    expect(stub.calls).toHaveLength(3);
    const token = stub.calls[0]!;
    expect(token.url).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(token.method).toBe("POST");
    expect(token.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      client_id: "client-id", client_secret: "client-secret", refresh_token: "1//refresh", grant_type: "refresh_token",
    });
    expect(stub.calls[1]!.headers.authorization).toBe("Bearer ya29.first");
    expect(stub.calls[2]!.headers.authorization).toBe("Bearer ya29.first");
    // The secret never leaves the token endpoint's body.
    for (const call of stub.calls) expect(call.url).not.toContain("client-secret");
  });

  it("refreshes again once the cached token is about to expire", async () => {
    const { social, stub } = publisher([
      tokenReply,
      postReply,
      postReply,
      { body: { access_token: "ya29.second", expires_in: 3600 } },
      postReply,
    ]);
    await social.publish(post());
    // 3599 s minus the 60 s skew: still cached at 58 minutes, refreshed at 59.
    vi.advanceTimersByTime(58 * 60 * 1000);
    await social.publish(post());
    expect(stub.calls).toHaveLength(3);
    vi.advanceTimersByTime(2 * 60 * 1000);
    await social.publish(post());
    expect(stub.calls).toHaveLength(5);
    expect(stub.calls[4]!.headers.authorization).toBe("Bearer ya29.second");
  });

  it("single-flights concurrent refreshes", async () => {
    const { social, stub } = publisher([tokenReply, postReply, postReply]);
    await Promise.all([social.publish(post()), social.publish(post())]);
    expect(stub.calls.filter((c) => c.url === GOOGLE_OAUTH_TOKEN_URL)).toHaveLength(1);
  });

  it("types a rejected refresh token as an auth error and does not retry it", async () => {
    const { social, stub } = publisher([
      { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
    ]);
    const error = await social.publish(post()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialAuthError);
    expect((error as SocialApiError).code).toBe("auth");
    expect((error as Error).message).toMatch(/invalid_grant: Token has been expired or revoked/);
    expect(stub.calls).toHaveLength(1);
  });

  it("drops the cached token after a 401 so the next publish refreshes", async () => {
    const { social, stub } = publisher([
      tokenReply,
      { status: 401, body: { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } } },
      { body: { access_token: "ya29.second", expires_in: 3600 } },
      postReply,
    ]);
    await expect(social.publish(post())).rejects.toBeInstanceOf(SocialAuthError);
    await expect(social.publish(post())).resolves.toEqual({ externalId: POST_NAME, url: SEARCH_URL });
    expect(stub.calls.map((c) => c.url)).toEqual([
      GOOGLE_OAUTH_TOKEN_URL, `${GBP_API_ENDPOINT}/${LOCATION}/localPosts`, GOOGLE_OAUTH_TOKEN_URL, `${GBP_API_ENDPOINT}/${LOCATION}/localPosts`,
    ]);
  });
});

describe("GbpPublisher.publish", () => {
  it("creates a STANDARD local post in en-GB and returns the post name and search url", async () => {
    const { social, stub } = publisher([tokenReply, postReply]);
    const result = await social.publish(post());

    expect(result).toEqual({ externalId: POST_NAME, url: SEARCH_URL });
    const call = stub.calls[1]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`https://mybusiness.googleapis.com/v4/${LOCATION}/localPosts`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual({
      languageCode: "en-GB", topicType: "STANDARD", summary: "Airport runs from £45, fixed price. Book online.",
    });
  });

  it("adds a Learn more call-to-action for a link and a PHOTO for an image", async () => {
    const { social, stub } = publisher([tokenReply, postReply]);
    await social.publish(post({ linkUrl: "https://grayscabline.co.uk/book", imageUrl: "https://cdn.launchflow.co.uk/a.jpg" }));
    expect(JSON.parse(stub.calls[1]!.body)).toEqual({
      languageCode: "en-GB",
      topicType: "STANDARD",
      summary: "Airport runs from £45, fixed price. Book online.",
      callToAction: { actionType: "LEARN_MORE", url: "https://grayscabline.co.uk/book" },
      media: [{ mediaFormat: "PHOTO", sourceUrl: "https://cdn.launchflow.co.uk/a.jpg" }],
    });
  });

  it("returns no url when Google omits searchUrl, rather than failing a post that is live", async () => {
    const { social } = publisher([tokenReply, { body: { name: POST_NAME, state: "PROCESSING" } }]);
    await expect(social.publish(post())).resolves.toEqual({ externalId: POST_NAME });
  });

  it("refuses a summary over 1500 characters before anything is sent", async () => {
    const { social, stub } = publisher([]);
    await expect(social.publish(post({ text: "x".repeat(1501) }))).rejects.toThrow(/1501 characters.*at most 1500/);
    await expect(social.publish(post({ text: "   " }))).rejects.toThrow(/summary is empty/);
    expect(stub.calls).toHaveLength(0);
  });

  it("accepts exactly 1500 characters, counting code points rather than UTF-16 units", async () => {
    const { social, stub } = publisher([tokenReply, postReply]);
    await social.publish(post({ text: "💷".repeat(1500) }));
    expect(stub.calls).toHaveLength(2);
  });

  it("refuses an externalId that is not a location resource name, and a non-gbp channel", async () => {
    const { social, stub } = publisher([]);
    await expect(social.publish(post({ externalId: "12345678901234567890" }))).rejects.toThrow(/accounts\/\{accountId\}\/locations/);
    await expect(social.publish(post({ externalId: "locations/123" }))).rejects.toThrow(TypeError);
    await expect(social.publish(post({ externalId: "accounts/1/locations/2/localPosts/3" }))).rejects.toThrow(TypeError);
    await expect(social.publish({ ...post(), channel: "facebook" })).rejects.toThrow(/cannot publish to channel "facebook"/);
    expect(stub.calls).toHaveLength(0);
  });

  it("types a 401 as an auth error", async () => {
    const { social } = publisher([
      tokenReply,
      { status: 401, body: { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } } },
    ]);
    const error = await social.publish(post()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialAuthError);
    expect(error).toMatchObject({ channel: "gbp", code: "auth", status: 401 });
    expect((error as Error).message).toMatch(/gbp publish 401: Invalid Credentials/);
  });

  it("types a 403 (API not enabled, project not approved, location not managed) as an auth error", async () => {
    const { social } = publisher([
      tokenReply,
      { status: 403, body: { error: { code: 403, message: "Google My Business API has not been used in project 507707 before or it is disabled.", status: "PERMISSION_DENIED" } } },
    ]);
    await expect(social.publish(post())).rejects.toMatchObject({ code: "auth", status: 403 });
  });

  it("retries a 429 once, honouring Retry-After, then gives up as a rate-limit error", async () => {
    const throttled: StubReply = {
      status: 429, headers: { "retry-after": "3" },
      body: { error: { code: 429, message: "Quota exceeded for quota metric 'Requests'", status: "RESOURCE_EXHAUSTED" } },
    };
    const ok = publisher([tokenReply, throttled, postReply]);
    await expect(ok.social.publish(post())).resolves.toEqual({ externalId: POST_NAME, url: SEARCH_URL });
    expect(ok.stub.slept).toEqual([3000]);
    expect(ok.stub.calls.filter((c) => c.url.endsWith("/localPosts"))).toHaveLength(2);

    const still = publisher([tokenReply, throttled, throttled]);
    const error = await still.social.publish(post()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialRateLimitError);
    expect(still.stub.calls).toHaveLength(3);
  });

  it("does not retry a 5xx on the post itself — Google may already have created it", async () => {
    const { social, stub } = publisher([
      tokenReply,
      { status: 503, body: { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } } },
    ]);
    const error = await social.publish(post()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialApiError);
    expect(error).toMatchObject({ code: "request_failed", status: 503 });
    expect(stub.calls).toHaveLength(2);
    expect(stub.slept).toEqual([]);
  });

  it("types a 400 that complains about the media as invalid media, and any other 400 as request_failed", async () => {
    const media = publisher([
      tokenReply,
      { status: 400, body: { error: { code: 400, message: "Media item could not be fetched from the provided source URL.", status: "INVALID_ARGUMENT" } } },
    ]);
    await expect(media.social.publish(post({ imageUrl: "https://x/y.png" }))).rejects.toBeInstanceOf(SocialInvalidMediaError);

    const other = publisher([
      tokenReply,
      { status: 400, body: { error: { code: 400, message: "Invalid value at 'local_post.language_code'", status: "INVALID_ARGUMENT" } } },
    ]);
    const error = await other.social.publish(post()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialApiError);
    expect(error).not.toBeInstanceOf(SocialInvalidMediaError);
    expect((error as SocialApiError).code).toBe("request_failed");
  });

  it("fails on a 200 whose body is not a JSON object or has no name", async () => {
    const noName = publisher([tokenReply, { body: { state: "LIVE" } }]);
    await expect(noName.social.publish(post())).rejects.toThrow(/localPosts returned no name/);
    const html = publisher([tokenReply, { body: "<html>maintenance</html>" }]);
    await expect(html.social.publish(post())).rejects.toThrow(/not a JSON object/);
  });
});

describe("GbpPublisher.listLocations", () => {
  it("lists every location of every account, named as v4 wants them", async () => {
    const { social, stub } = publisher([
      tokenReply,
      { body: { accounts: [
        { name: "accounts/106000000000000000001", accountName: "LaunchFlow", type: "LOCATION_GROUP" },
        { name: "accounts/106000000000000000002", accountName: "Shoji", type: "PERSONAL" },
      ] } },
      { body: { locations: [
        { name: "locations/111", title: "Grays CabLine" },
        { name: "locations/222", title: "Mobile PC Doctor" },
      ] } },
      { body: {} },
    ]);
    const locations = await social.listLocations();

    expect(locations).toEqual([
      { name: "accounts/106000000000000000001/locations/111", title: "Grays CabLine", accountName: "LaunchFlow" },
      { name: "accounts/106000000000000000001/locations/222", title: "Mobile PC Doctor", accountName: "LaunchFlow" },
    ]);
    expect(stub.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", GOOGLE_OAUTH_TOKEN_URL],
      ["GET", `${GBP_ACCOUNTS_ENDPOINT}/accounts`],
      ["GET", `${GBP_LOCATIONS_ENDPOINT}/accounts/106000000000000000001/locations?readMask=name,title`],
      ["GET", `${GBP_LOCATIONS_ENDPOINT}/accounts/106000000000000000002/locations?readMask=name,title`],
    ]);
    expect(stub.calls[1]!.headers.authorization).toBe("Bearer ya29.first");
  });

  it("follows nextPageToken", async () => {
    const { social, stub } = publisher([
      tokenReply,
      { body: { accounts: [{ name: "accounts/1", accountName: "A" }] } },
      { body: { locations: [{ name: "locations/1", title: "One" }], nextPageToken: "p2" } },
      { body: { locations: [{ name: "locations/2", title: "Two" }] } },
    ]);
    const locations = await social.listLocations();
    expect(locations.map((l) => l.name)).toEqual(["accounts/1/locations/1", "accounts/1/locations/2"]);
    expect(stub.calls[3]!.url).toBe(`${GBP_LOCATIONS_ENDPOINT}/accounts/1/locations?readMask=name,title&pageToken=p2`);
  });

  it("retries a 5xx on these reads once", async () => {
    const { social, stub } = publisher([
      tokenReply,
      { status: 502, body: "bad gateway" },
      { body: { accounts: [] } },
    ]);
    await expect(social.listLocations()).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(3);
    expect(stub.slept).toEqual([1000]);
  });
});
