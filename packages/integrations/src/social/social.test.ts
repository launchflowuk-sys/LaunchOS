import { describe, expect, it } from "vitest";
import { fetchStub } from "../ads/stub-fetch.js";
import {
  CompositeSocialPublisher, createSocialPublisherFromEnv, GBP_ENV_KEYS, GbpPublisher, hasGbpCredentials, hasMetaSocialCredentials,
  META_SOCIAL_ENV_KEYS, MetaSocialPublisher, MockSocialPublisher,
} from "./index.js";

const META = { META_ADS_ACCESS_TOKEN: "EAAG", META_ADS_APP_SECRET: "app" };
const GBP = { GBP_CLIENT_ID: "cid", GBP_CLIENT_SECRET: "sec", GBP_REFRESH_TOKEN: "1//r" };
const LOCATION = "accounts/1/locations/2";

describe("MockSocialPublisher", () => {
  it("records every call and answers with deterministic ids and permalinks", async () => {
    const social = new MockSocialPublisher();
    const fb = await social.publish({ channel: "facebook", externalId: "101", text: "hello" });
    const ig = await social.publish({ channel: "instagram", externalId: "178", text: "hi", imageUrl: "https://x/y.jpg" });
    const gbp = await social.publish({ channel: "gbp", externalId: LOCATION, text: "update" });

    expect(fb).toEqual({ externalId: "mock-facebook-1", url: "https://www.facebook.com/101/posts/1" });
    expect(ig).toEqual({ externalId: "mock-instagram-2", url: "https://www.instagram.com/p/mock-2/" });
    expect(gbp).toEqual({ externalId: "mock-gbp-3", url: "https://local.google.com/place?use=posts&lpsid=mock-3" });
    expect(social.calls).toEqual([
      { channel: "facebook", externalId: "101", text: "hello" },
      { channel: "instagram", externalId: "178", text: "hi", imageUrl: "https://x/y.jpg" },
      { channel: "gbp", externalId: LOCATION, text: "update" },
    ]);
    expect(social.name).toBe("mock-social");
  });

  it("throws a queued failure once, then recovers", async () => {
    const social = new MockSocialPublisher();
    social.failNext(new Error("simulated outage"));
    await expect(social.publish({ channel: "facebook", externalId: "101", text: "a" })).rejects.toThrow("simulated outage");
    await expect(social.publish({ channel: "facebook", externalId: "101", text: "b" })).resolves.toMatchObject({
      externalId: "mock-facebook-2",
    });
    expect(social.calls).toHaveLength(2);
  });
});

describe("CompositeSocialPublisher", () => {
  it("routes facebook and instagram to the Meta half and gbp to the GBP half", async () => {
    const meta = new MockSocialPublisher();
    const gbp = new MockSocialPublisher();
    const social = new CompositeSocialPublisher({ meta, gbp });
    await social.publish({ channel: "facebook", externalId: "1", text: "fb" });
    await social.publish({ channel: "instagram", externalId: "2", text: "ig", imageUrl: "https://x/y.jpg" });
    await social.publish({ channel: "gbp", externalId: LOCATION, text: "g" });
    expect(meta.calls.map((c) => c.channel)).toEqual(["facebook", "instagram"]);
    expect(gbp.calls.map((c) => c.channel)).toEqual(["gbp"]);
    expect(social.for("gbp")).toBe(gbp);
    expect(social.for("facebook")).toBe(meta);
  });

  it("is named after its real halves, in the guard's vocabulary", () => {
    const stub = fetchStub([]);
    const meta = new MetaSocialPublisher({ accessToken: "EAAG", appSecret: "app", fetch: stub.fetch });
    const gbp = new GbpPublisher({ clientId: "a", clientSecret: "b", refreshToken: "c", fetch: stub.fetch });
    const mock = new MockSocialPublisher();
    expect(new CompositeSocialPublisher({ meta, gbp }).name).toBe("meta+gbp");
    expect(new CompositeSocialPublisher({ meta, gbp: mock }).name).toBe("meta");
    expect(new CompositeSocialPublisher({ meta: mock, gbp }).name).toBe("gbp");
    expect(new CompositeSocialPublisher({ meta: mock, gbp: mock }).name).toBe("mock-social");
  });
});

describe("createSocialPublisherFromEnv", () => {
  it("builds the plain mock when neither provider has all of its keys", () => {
    expect(createSocialPublisherFromEnv({})).toBeInstanceOf(MockSocialPublisher);
    expect(createSocialPublisherFromEnv({ META_ADS_ACCESS_TOKEN: "EAAG" })).toBeInstanceOf(MockSocialPublisher);
    expect(createSocialPublisherFromEnv({ ...META, META_ADS_APP_SECRET: "  " })).toBeInstanceOf(MockSocialPublisher);
    expect(createSocialPublisherFromEnv({ GBP_CLIENT_ID: "cid", GBP_CLIENT_SECRET: "sec" })).toBeInstanceOf(MockSocialPublisher);
    expect(hasMetaSocialCredentials({ ...META, META_ADS_APP_SECRET: "" })).toBe(false);
    expect(hasGbpCredentials({ ...GBP, GBP_REFRESH_TOKEN: " " })).toBe(false);
  });

  it("builds a composite with a real Meta half when both Meta keys are set, sharing the ads adapter's keys", () => {
    const social = createSocialPublisherFromEnv(META);
    expect(social).toBeInstanceOf(CompositeSocialPublisher);
    expect(social.name).toBe("meta");
    const composite = social as CompositeSocialPublisher;
    expect(composite.for("facebook")).toBeInstanceOf(MetaSocialPublisher);
    expect(composite.for("gbp")).toBeInstanceOf(MockSocialPublisher);
    expect(hasMetaSocialCredentials(META)).toBe(true);
    expect(META_SOCIAL_ENV_KEYS).toEqual(["META_ADS_ACCESS_TOKEN", "META_ADS_APP_SECRET"]);
  });

  it("builds a composite with a real GBP half when the three GBP keys are set", () => {
    const social = createSocialPublisherFromEnv(GBP) as CompositeSocialPublisher;
    expect(social.name).toBe("gbp");
    expect(social.for("gbp")).toBeInstanceOf(GbpPublisher);
    expect(social.for("instagram")).toBeInstanceOf(MockSocialPublisher);
    expect(hasGbpCredentials(GBP)).toBe(true);
    expect(GBP_ENV_KEYS).toEqual(["GBP_CLIENT_ID", "GBP_CLIENT_SECRET", "GBP_REFRESH_TOKEN"]);
  });

  it("builds both halves real when both sets are", () => {
    const social = createSocialPublisherFromEnv({ ...META, ...GBP }) as CompositeSocialPublisher;
    expect(social.name).toBe("meta+gbp");
    expect(social.for("facebook")).toBeInstanceOf(MetaSocialPublisher);
    expect(social.for("gbp")).toBeInstanceOf(GbpPublisher);
  });

  it("honours META_ADS_API_VERSION and the injected fetch", async () => {
    const stub = fetchStub([{ body: { access_token: "page" } }, { body: { id: "1_2" } }, { body: { permalink_url: "https://fb/2" } }]);
    const social = createSocialPublisherFromEnv({ ...META, META_ADS_API_VERSION: "v99.0" }, { fetch: stub.fetch, sleep: stub.sleep });
    await social.publish({ channel: "facebook", externalId: "1", text: "x" });
    expect(stub.calls[0]!.url).toMatch(/^https:\/\/graph\.facebook\.com\/v99\.0\/1\?fields=access_token/);
  });

  it("hands the injected fetch and endpoints to the GBP half", async () => {
    const stub = fetchStub([{ body: { access_token: "t", expires_in: 3600 } }, { body: { name: `${LOCATION}/localPosts/1` } }]);
    const social = createSocialPublisherFromEnv(GBP, {
      fetch: stub.fetch, sleep: stub.sleep, tokenUrl: "https://token.test/x", endpoint: "https://posts.test/v4",
    });
    await expect(social.publish({ channel: "gbp", externalId: LOCATION, text: "x" })).resolves.toEqual({
      externalId: `${LOCATION}/localPosts/1`,
    });
    expect(stub.calls.map((c) => c.url)).toEqual(["https://token.test/x", `https://posts.test/v4/${LOCATION}/localPosts`]);
  });
});
