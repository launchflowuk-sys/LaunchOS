import { describe, expect, it } from "vitest";
import { fetchStub } from "../ads/stub-fetch.js";
import { createSocialPublisherFromEnv, hasMetaSocialCredentials, META_SOCIAL_ENV_KEYS, MetaSocialPublisher, MockSocialPublisher } from "./index.js";

const META = { META_ADS_ACCESS_TOKEN: "EAAG", META_ADS_APP_SECRET: "app" };

describe("MockSocialPublisher", () => {
  it("records every call and answers with deterministic ids and permalinks", async () => {
    const social = new MockSocialPublisher();
    const fb = await social.publish({ channel: "facebook", externalId: "101", text: "hello" });
    const ig = await social.publish({ channel: "instagram", externalId: "178", text: "hi", imageUrl: "https://x/y.jpg" });

    expect(fb).toEqual({ externalId: "mock-facebook-1", url: "https://www.facebook.com/101/posts/1" });
    expect(ig).toEqual({ externalId: "mock-instagram-2", url: "https://www.instagram.com/p/mock-2/" });
    expect(social.calls).toEqual([
      { channel: "facebook", externalId: "101", text: "hello" },
      { channel: "instagram", externalId: "178", text: "hi", imageUrl: "https://x/y.jpg" },
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

describe("createSocialPublisherFromEnv", () => {
  it("builds the mock when either Meta key is unset or blank", () => {
    expect(createSocialPublisherFromEnv({})).toBeInstanceOf(MockSocialPublisher);
    expect(createSocialPublisherFromEnv({ META_ADS_ACCESS_TOKEN: "EAAG" })).toBeInstanceOf(MockSocialPublisher);
    expect(createSocialPublisherFromEnv({ ...META, META_ADS_APP_SECRET: "  " })).toBeInstanceOf(MockSocialPublisher);
    expect(hasMetaSocialCredentials({ ...META, META_ADS_APP_SECRET: "" })).toBe(false);
  });

  it("builds the real publisher when both are set, sharing the ads adapter's keys", () => {
    const social = createSocialPublisherFromEnv(META);
    expect(social).toBeInstanceOf(MetaSocialPublisher);
    expect(social.name).toBe("meta");
    expect(hasMetaSocialCredentials(META)).toBe(true);
    expect(META_SOCIAL_ENV_KEYS).toEqual(["META_ADS_ACCESS_TOKEN", "META_ADS_APP_SECRET"]);
  });

  it("honours META_ADS_API_VERSION and the injected fetch", async () => {
    const stub = fetchStub([{ body: { access_token: "page" } }, { body: { id: "1_2" } }, { body: { permalink_url: "https://fb/2" } }]);
    const social = createSocialPublisherFromEnv({ ...META, META_ADS_API_VERSION: "v99.0" }, { fetch: stub.fetch, sleep: stub.sleep });
    await social.publish({ channel: "facebook", externalId: "1", text: "x" });
    expect(stub.calls[0]!.url).toMatch(/^https:\/\/graph\.facebook\.com\/v99\.0\/1\?fields=access_token/);
  });
});
