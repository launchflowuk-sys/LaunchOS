import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchStub, type StubReply } from "../ads/stub-fetch.js";
import { SocialApiError, SocialAuthError, SocialInvalidMediaError, SocialRateLimitError } from "./errors.js";
import { META_GRAPH_API_VERSION, MetaSocialPublisher, type MetaSocialOptions } from "./meta.js";

const SYSTEM_TOKEN = "EAAG-system-user-token";
const PAGE_TOKEN = "EAAG-page-token";
const APP_SECRET = "app-secret";
const proofOf = (token: string): string => createHmac("sha256", APP_SECRET).update(token).digest("hex");
const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

const PAGE_ID = "101234567890123";
const IG_USER_ID = "17841400000000000";

/** The `GET /{pageId}?fields=access_token` reply every Facebook publish starts with. */
const pageTokenReply: StubReply = { body: { access_token: PAGE_TOKEN, id: PAGE_ID } };

function publisher(replies: StubReply[], options: Partial<MetaSocialOptions> = {}) {
  const stub = fetchStub(replies);
  const social = new MetaSocialPublisher({
    accessToken: SYSTEM_TOKEN, appSecret: APP_SECRET, pollIntervalMs: 2_000, ...options, fetch: stub.fetch, sleep: stub.sleep,
  });
  return { social, stub };
}

describe("MetaSocialPublisher credentials", () => {
  it("refuses to construct without credentials", () => {
    expect(() => new MetaSocialPublisher({})).toThrow(/credentials required/i);
    expect(() => new MetaSocialPublisher({ accessToken: SYSTEM_TOKEN })).toThrow(/appSecret/);
  });
});

describe("MetaSocialPublisher on Facebook", () => {
  it("publishes a text post to the page feed with the page token and returns the permalink", async () => {
    const { social, stub } = publisher([
      pageTokenReply,
      { body: { id: `${PAGE_ID}_555` } },
      { body: { permalink_url: "https://www.facebook.com/101234567890123/posts/555", id: `${PAGE_ID}_555` } },
    ]);

    const result = await social.publish({
      channel: "facebook", externalId: PAGE_ID, text: "Airport runs from £45. Book online.", linkUrl: "https://grayscabline.co.uk/book",
    });

    expect(result).toEqual({ externalId: `${PAGE_ID}_555`, url: "https://www.facebook.com/101234567890123/posts/555" });
    expect(stub.calls).toHaveLength(3);

    // 1. The page token, fetched with the system-user token and its proof.
    const tokenCall = stub.calls[0]!;
    expect(tokenCall.method).toBe("GET");
    expect(tokenCall.url).toBe(`${GRAPH}/${PAGE_ID}?fields=access_token&appsecret_proof=${proofOf(SYSTEM_TOKEN)}`);
    expect(tokenCall.headers.authorization).toBe(`Bearer ${SYSTEM_TOKEN}`);

    // 2. The post, with the *page* token and a proof computed for that token.
    const feed = stub.calls[1]!;
    expect(feed.method).toBe("POST");
    expect(feed.url).toBe(`${GRAPH}/${PAGE_ID}/feed?appsecret_proof=${proofOf(PAGE_TOKEN)}`);
    expect(feed.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(JSON.parse(feed.body)).toEqual({ message: "Airport runs from £45. Book online.", link: "https://grayscabline.co.uk/book" });
    // No token ever travels in a URL.
    for (const call of stub.calls) expect(call.url).not.toMatch(/access_token=/);

    // 3. The permalink.
    expect(stub.calls[2]!.url).toBe(`${GRAPH}/${PAGE_ID}_555?fields=permalink_url&appsecret_proof=${proofOf(PAGE_TOKEN)}`);
  });

  it("publishes a photo post through /photos and keeps the feed story's post_id", async () => {
    const { social, stub } = publisher([
      pageTokenReply,
      { body: { id: "777", post_id: `${PAGE_ID}_778` } },
      { body: { permalink_url: "https://www.facebook.com/photo/?fbid=777" } },
    ]);

    const result = await social.publish({
      channel: "facebook", externalId: PAGE_ID, text: "New car on the fleet.", imageUrl: "https://cdn.example.com/car.jpg",
    });

    expect(result).toEqual({ externalId: `${PAGE_ID}_778`, url: "https://www.facebook.com/photo/?fbid=777" });
    const photo = stub.calls[1]!;
    expect(photo.url).toBe(`${GRAPH}/${PAGE_ID}/photos?appsecret_proof=${proofOf(PAGE_TOKEN)}`);
    expect(JSON.parse(photo.body)).toEqual({ url: "https://cdn.example.com/car.jpg", caption: "New car on the fleet." });
  });

  it("appends the link to a photo caption, since /photos takes no link attachment", async () => {
    const { social, stub } = publisher([
      pageTokenReply,
      { body: { id: "1", post_id: `${PAGE_ID}_2` } },
      { body: { permalink_url: "https://www.facebook.com/x" } },
    ]);
    await social.publish({
      channel: "facebook", externalId: PAGE_ID, text: "Book now.", imageUrl: "https://cdn.example.com/a.jpg", linkUrl: "https://grayscabline.co.uk",
    });
    expect(JSON.parse(stub.calls[1]!.body)).toEqual({
      url: "https://cdn.example.com/a.jpg", caption: "Book now.\n\nhttps://grayscabline.co.uk",
    });
  });

  it("caches the page token across publishes to the same page", async () => {
    const { social, stub } = publisher([
      pageTokenReply,
      { body: { id: `${PAGE_ID}_1` } },
      { body: { permalink_url: "https://www.facebook.com/1" } },
      { body: { id: `${PAGE_ID}_2` } },
      { body: { permalink_url: "https://www.facebook.com/2" } },
    ]);
    await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "one" });
    await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "two" });

    expect(stub.calls).toHaveLength(5);
    expect(stub.calls.filter((call) => call.url.includes("fields=access_token"))).toHaveLength(1);
    expect(stub.calls[3]!.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  it("drops a cached page token that Graph rejects, so the next publish fetches it again", async () => {
    const expired: StubReply = {
      status: 400, body: { error: { message: "Error validating access token: Session has expired", code: 190 } },
    };
    const { social, stub } = publisher([
      pageTokenReply,
      expired,
      { body: { access_token: "EAAG-new-page-token" } },
      { body: { id: `${PAGE_ID}_9` } },
      { body: { permalink_url: "https://www.facebook.com/9" } },
    ]);
    await expect(social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" })).rejects.toBeInstanceOf(SocialAuthError);
    const result = await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" });
    expect(result.externalId).toBe(`${PAGE_ID}_9`);
    expect(stub.calls[3]!.headers.authorization).toBe("Bearer EAAG-new-page-token");
    expect(stub.calls[3]!.url).toContain(`appsecret_proof=${proofOf("EAAG-new-page-token")}`);
  });

  it("returns the id without a url when the permalink lookup fails — the post is live by then", async () => {
    const { social } = publisher([
      pageTokenReply,
      { body: { id: `${PAGE_ID}_5` } },
      { status: 500, body: "upstream error" },
      // The 500 on a GET is retried once; make that fail too.
      { status: 500, body: "upstream error" },
    ]);
    const result = await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" });
    expect(result).toEqual({ externalId: `${PAGE_ID}_5` });
    expect("url" in result).toBe(false);
  });

  it("names a page whose token the system user cannot read", async () => {
    const { social } = publisher([{ body: { id: PAGE_ID, name: "Grays CabLine" } }]);
    await expect(social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" })).rejects.toThrow(/returned no access_token/);
  });

  it("refuses an external id that is not a Graph id before sending anything", async () => {
    const { social, stub } = publisher([]);
    await expect(social.publish({ channel: "facebook", externalId: "../me", text: "x" })).rejects.toThrow(/not a Graph id/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("MetaSocialPublisher on Instagram", () => {
  const container: StubReply = { body: { id: "18000000000000001" } };
  const finished: StubReply = { body: { status_code: "FINISHED", id: "18000000000000001" } };
  const inProgress: StubReply = { body: { status_code: "IN_PROGRESS", status: "In progress", id: "18000000000000001" } };
  const published: StubReply = { body: { id: "17900000000000002" } };
  const permalink: StubReply = { body: { permalink: "https://www.instagram.com/p/CxYz123/" } };

  it("creates a container, waits for FINISHED, publishes it and returns the permalink", async () => {
    const { social, stub } = publisher([container, inProgress, inProgress, finished, published, permalink]);

    const result = await social.publish({
      channel: "instagram", externalId: IG_USER_ID, text: "Fresh trims this weekend.", imageUrl: "https://cdn.example.com/cat.jpg",
      linkUrl: "https://starcatgrooming.co.uk",
    });

    expect(result).toEqual({ externalId: "17900000000000002", url: "https://www.instagram.com/p/CxYz123/" });
    expect(stub.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`)).toEqual([
      `POST ${GRAPH}/${IG_USER_ID}/media`,
      `GET ${GRAPH}/18000000000000001`,
      `GET ${GRAPH}/18000000000000001`,
      `GET ${GRAPH}/18000000000000001`,
      `POST ${GRAPH}/${IG_USER_ID}/media_publish`,
      `GET ${GRAPH}/17900000000000002`,
    ]);
    // Instagram calls carry the system-user token, signed for it.
    for (const call of stub.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${SYSTEM_TOKEN}`);
      expect(call.url).toContain(`appsecret_proof=${proofOf(SYSTEM_TOKEN)}`);
    }
    expect(JSON.parse(stub.calls[0]!.body)).toEqual({
      image_url: "https://cdn.example.com/cat.jpg", caption: "Fresh trims this weekend.\n\nhttps://starcatgrooming.co.uk",
    });
    expect(stub.calls[1]!.url).toContain("fields=status_code,status");
    expect(JSON.parse(stub.calls[4]!.body)).toEqual({ creation_id: "18000000000000001" });
    expect(stub.calls[5]!.url).toContain("fields=permalink");
    // Two IN_PROGRESS answers, two waits of the configured interval.
    expect(stub.slept).toEqual([2_000, 2_000]);
  });

  it("gives up on a container that never finishes and types it as a timeout", async () => {
    const { social, stub } = publisher([container, inProgress, inProgress, inProgress], { pollAttempts: 3 });
    const error = await social
      .publish({ channel: "instagram", externalId: IG_USER_ID, text: "x", imageUrl: "https://cdn.example.com/a.jpg" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialApiError);
    expect((error as SocialApiError).code).toBe("timeout");
    expect((error as Error).message).toMatch(/still IN_PROGRESS after 3 checks/);
    // Three status checks, two waits between them, and media_publish never sent.
    expect(stub.calls).toHaveLength(4);
    expect(stub.slept).toHaveLength(2);
    expect(stub.remaining()).toBe(0);
  });

  it("types a container that ends in ERROR as invalid media", async () => {
    const { social } = publisher([
      container,
      { body: { status_code: "ERROR", status: "Error: Media is not a supported format." } },
    ]);
    const error = await social
      .publish({ channel: "instagram", externalId: IG_USER_ID, text: "x", imageUrl: "https://cdn.example.com/a.bmp" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialInvalidMediaError);
    expect((error as Error).message).toMatch(/not a supported format/);
  });

  it("types Graph's own media rejection (subcode 2207xxx) as invalid media", async () => {
    const { social } = publisher([
      { status: 400, body: { error: { message: "The image is too large", code: 36000, error_subcode: 2207004 } } },
    ]);
    await expect(
      social.publish({ channel: "instagram", externalId: IG_USER_ID, text: "x", imageUrl: "https://cdn.example.com/huge.jpg" }),
    ).rejects.toBeInstanceOf(SocialInvalidMediaError);
  });

  it("refuses a text-only Instagram post without calling Graph", async () => {
    const { social, stub } = publisher([]);
    await expect(social.publish({ channel: "instagram", externalId: IG_USER_ID, text: "no image" })).rejects.toBeInstanceOf(
      SocialInvalidMediaError,
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("returns the media id without a url when the permalink lookup fails", async () => {
    const { social } = publisher([
      container, finished, published,
      { status: 400, body: { error: { message: "(#100) Unsupported get request", code: 100 } } },
    ]);
    const result = await social.publish({
      channel: "instagram", externalId: IG_USER_ID, text: "x", imageUrl: "https://cdn.example.com/a.jpg",
    });
    expect(result).toEqual({ externalId: "17900000000000002" });
  });
});

describe("MetaSocialPublisher failures", () => {
  it("types an expired token as an auth error and does not retry it", async () => {
    const { social, stub } = publisher([
      { status: 400, body: { error: { message: "Error validating access token: Session has expired", code: 190 } } },
    ]);
    const error = await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialAuthError);
    expect((error as SocialApiError).code).toBe("auth");
    expect((error as Error).message).toMatch(/Session has expired/);
    expect(stub.calls).toHaveLength(1);
    expect(stub.slept).toHaveLength(0);
  });

  it("types a missing permission as an auth error", async () => {
    const { social } = publisher([
      pageTokenReply,
      { status: 403, body: { error: { message: "(#200) Requires pages_manage_posts permission", code: 200 } } },
    ]);
    await expect(social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" })).rejects.toBeInstanceOf(SocialAuthError);
  });

  it("retries a 429 once, honouring Retry-After, and succeeds", async () => {
    const { social, stub } = publisher([
      pageTokenReply,
      { status: 429, body: { error: { message: "User request limit reached", code: 17 } }, headers: { "retry-after": "3" } },
      { body: { id: `${PAGE_ID}_1` } },
      { body: { permalink_url: "https://www.facebook.com/1" } },
    ]);
    const result = await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" });
    expect(result.externalId).toBe(`${PAGE_ID}_1`);
    expect(stub.slept).toEqual([3000]);
    expect(stub.calls).toHaveLength(4);
  });

  it("gives up after one retry and types the failure as a rate limit", async () => {
    const throttled: StubReply = { status: 400, body: { error: { message: "Application request limit reached", code: 4 } } };
    const { social, stub } = publisher([pageTokenReply, throttled, throttled]);
    const error = await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialRateLimitError);
    expect((error as SocialApiError).code).toBe("rate_limit");
    expect(stub.slept).toHaveLength(1);
  });

  it("does not retry a 5xx on a write — the post may already be up", async () => {
    const { social, stub } = publisher([pageTokenReply, { status: 502, body: "bad gateway" }]);
    const error = await social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialApiError);
    expect((error as SocialApiError).code).toBe("request_failed");
    expect(stub.calls).toHaveLength(2);
    expect(stub.slept).toHaveLength(0);
  });

  it("types Facebook's unreadable-photo error as invalid media", async () => {
    const { social } = publisher([
      pageTokenReply,
      { status: 400, body: { error: { message: "(#324) Missing or invalid image file", code: 324 } } },
    ]);
    await expect(
      social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x", imageUrl: "https://cdn.example.com/404.jpg" }),
    ).rejects.toBeInstanceOf(SocialInvalidMediaError);
  });

  it("throws on an error envelope that arrives with HTTP 200", async () => {
    const { social } = publisher([{ status: 200, body: { error: { message: "Session has expired", code: 190 } } }]);
    await expect(social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" })).rejects.toBeInstanceOf(SocialAuthError);
  });

  it("reports a body that is not JSON rather than guessing", async () => {
    const { social } = publisher([{ status: 200, body: "<html>maintenance</html>" }]);
    await expect(social.publish({ channel: "facebook", externalId: PAGE_ID, text: "x" })).rejects.toThrow(/not a JSON object/);
  });
});
