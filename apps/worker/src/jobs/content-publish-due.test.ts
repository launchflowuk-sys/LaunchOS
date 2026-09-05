import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MAX_CONTENT_PUBLISH_ATTEMPTS } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import {
  MockCmsProvider, MockSocialPublisher, SocialAuthError, SocialInvalidMediaError, SocialRateLimitError, WordPressCmsError,
} from "@launchos/integrations";
import { classifyPublishError, runPublishDue } from "./content-publish-due.js";
import { approvedItem, connectChannel, contentJobFixture, itemById, silentLogger } from "./content-test-fixture.js";

const NOW = new Date("2026-09-12T09:05:00Z");
const DUE = new Date("2026-09-12T09:00:00Z");

function deps(db: Parameters<typeof runPublishDue>[0]["db"]) {
  const social = new MockSocialPublisher();
  const cms = new MockCmsProvider();
  return { social, cms, deps: { db, social, cms, logger: silentLogger() } };
}

function ownerNotifications(db: Parameters<typeof runPublishDue>[0]["db"], orgId: string) {
  return db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, "content_item.failed")));
}

describe("runPublishDue", () => {
  it("publishes a due Facebook post through the social publisher and records the id and permalink", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await connectChannel(db, f.orgId, f.clientId, "facebook", "1234567890");
      const item = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE, { linkUrl: "https://grayscabline.co.uk/airport" });
      await approvedItem(db, f.orgId, f.clientId, "facebook", new Date("2026-09-20T09:00:00Z"), { body: "Not yet due" });
      const { social, deps: d } = deps(db);

      const result = await runPublishDue(d, f.orgId, { now: NOW });

      expect(result).toEqual({ claimed: 1, published: 1, retried: 0, failed: 0, errored: 0 });
      expect(social.calls).toEqual([{
        channel: "facebook", externalId: "1234567890", text: "Fixed fares to Stansted, booked in advance.",
        linkUrl: "https://grayscabline.co.uk/airport",
      }]);
      const after = await itemById(db, item.id);
      expect(after.status).toBe("published");
      expect(after.externalId).toBe("mock-facebook-1");
      expect(after.externalUrl).toBe("https://www.facebook.com/1234567890/posts/1");
      expect(after.publishedAt).not.toBeNull();
      // The second sweep finds nothing: the first claimed and settled it.
      expect(await runPublishDue(d, f.orgId, { now: NOW })).toMatchObject({ claimed: 0 });
    });
  });

  it("publishes a blog post through the CMS provider with the client's blog site id and the featured image", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const [site] = await db.insert(schema.sites)
        .values({ organisationId: f.orgId, clientId: f.clientId, name: "Site", primaryUrl: "https://grayscabline.co.uk" }).returning();
      await connectChannel(db, f.orgId, f.clientId, "blog", site!.id);
      const item = await approvedItem(db, f.orgId, f.clientId, "blog", DUE, {
        title: "Getting to Stansted", body: "## Early\n\nBook ahead.", imageUrl: "https://cdn.test/hero.jpg",
      });
      const { social, cms, deps: d } = deps(db);

      const result = await runPublishDue(d, f.orgId, { now: NOW });

      expect(result).toMatchObject({ claimed: 1, published: 1 });
      expect(social.calls).toEqual([]);
      expect(cms.posts).toEqual([{
        siteId: site!.id, title: "Getting to Stansted", contentMarkdown: "## Early\n\nBook ahead.", status: "publish",
        featuredImageUrl: "https://cdn.test/hero.jpg",
      }]);
      const after = await itemById(db, item.id);
      expect(after).toMatchObject({ status: "published", externalId: "mock-post-1", externalUrl: "https://mock-cms.local/?p=1" });
    });
  });

  it("routes GBP and Instagram to the social publisher, passing the image through", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await connectChannel(db, f.orgId, f.clientId, "gbp", "accounts/1/locations/2");
      await connectChannel(db, f.orgId, f.clientId, "instagram", "17841400000000000");
      await approvedItem(db, f.orgId, f.clientId, "gbp", DUE, { body: "Open 24 hours." });
      await approvedItem(db, f.orgId, f.clientId, "instagram", DUE, { body: "Dawn run.", imageUrl: "https://cdn.test/dawn.jpg" });
      const { social, deps: d } = deps(db);

      const result = await runPublishDue(d, f.orgId, { now: NOW });

      expect(result).toMatchObject({ claimed: 2, published: 2, failed: 0 });
      expect(social.calls.map((c) => c.channel).sort()).toEqual(["gbp", "instagram"]);
      expect(social.calls.find((c) => c.channel === "instagram")).toMatchObject({ externalId: "17841400000000000", imageUrl: "https://cdn.test/dawn.jpg" });
    });
  });

  it("puts a rate-limited item back for the next sweep, counts the attempt, and fails it after the third", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await connectChannel(db, f.orgId, f.clientId, "facebook", "1234567890");
      const item = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE);
      const { social, deps: d } = deps(db);

      for (let attempt = 1; attempt < MAX_CONTENT_PUBLISH_ATTEMPTS; attempt += 1) {
        social.failNext(new SocialRateLimitError("facebook", 429, "throttled"));
        const result = await runPublishDue(d, f.orgId, { now: NOW });
        expect(result).toMatchObject({ claimed: 1, published: 0, retried: 1, failed: 0 });
        const after = await itemById(db, item.id);
        expect(after.status).toBe("approved");
        expect(after.metadata.publishAttempts).toBe(attempt);
        expect(after.lastError).toContain("throttled");
      }
      expect(await ownerNotifications(db, f.orgId)).toHaveLength(0);

      social.failNext(new SocialRateLimitError("facebook", 429, "still throttled"));
      const last = await runPublishDue(d, f.orgId, { now: NOW });
      expect(last).toMatchObject({ claimed: 1, retried: 0, failed: 1 });
      const after = await itemById(db, item.id);
      expect(after.status).toBe("failed");
      expect(after.metadata.publishAttempts).toBe(MAX_CONTENT_PUBLISH_ATTEMPTS);
      expect(await ownerNotifications(db, f.orgId)).toHaveLength(1);
      expect(social.calls).toHaveLength(MAX_CONTENT_PUBLISH_ATTEMPTS);
      // Failed is terminal for the sweep: nothing claims it again.
      expect(await runPublishDue(d, f.orgId, { now: NOW })).toMatchObject({ claimed: 0 });
    });
  });

  it("fails an auth error at once, with the message for a human, and tells the owner", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await connectChannel(db, f.orgId, f.clientId, "facebook", "1234567890");
      const item = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE);
      const { social, deps: d } = deps(db);
      social.failNext(new SocialAuthError("facebook", 190, "token expired"));

      const result = await runPublishDue(d, f.orgId, { now: NOW });

      expect(result).toMatchObject({ claimed: 1, published: 0, retried: 0, failed: 1 });
      const after = await itemById(db, item.id);
      expect(after.status).toBe("failed");
      expect(after.metadata.publishAttempts).toBe(1);
      expect(after.lastError).toContain("token expired");
      const [notice] = await ownerNotifications(db, f.orgId);
      expect(notice!.link).toBe(`/content/${item.id}`);
      expect(notice!.title).toContain("Grays CabLine");
    });
  });

  it("fails an item whose channel is not connected without calling any publisher", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      // A channel that exists but is switched off counts as not connected.
      await connectChannel(db, f.orgId, f.clientId, "gbp", "accounts/1/locations/2");
      await db.update(schema.contentChannels).set({ enabled: false }).where(eq(schema.contentChannels.clientId, f.clientId));
      const fb = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE);
      const gbp = await approvedItem(db, f.orgId, f.clientId, "gbp", DUE, { body: "Open late." });
      const { social, cms, deps: d } = deps(db);

      const result = await runPublishDue(d, f.orgId, { now: NOW });

      expect(result).toMatchObject({ claimed: 2, published: 0, retried: 0, failed: 2 });
      expect(social.calls).toEqual([]);
      expect(cms.posts).toEqual([]);
      const fbAfter = await itemById(db, fb.id);
      expect(fbAfter.status).toBe("failed");
      expect(fbAfter.lastError).toMatch(/No Facebook Page is connected/);
      expect(fbAfter.metadata.publishAttempts).toBe(1);
      expect((await itemById(db, gbp.id)).lastError).toMatch(/No Google Business Profile location is connected/);
      expect(await ownerNotifications(db, f.orgId)).toHaveLength(2);
    });
  });

  it("fails an Instagram post with no image before it reaches the publisher", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await connectChannel(db, f.orgId, f.clientId, "instagram", "17841400000000000");
      const item = await approvedItem(db, f.orgId, f.clientId, "instagram", DUE, { body: "No picture." });
      const { social, deps: d } = deps(db);

      const result = await runPublishDue(d, f.orgId, { now: NOW });

      expect(result).toMatchObject({ failed: 1, retried: 0 });
      expect(social.calls).toEqual([]);
      expect((await itemById(db, item.id)).lastError).toMatch(/needs an image/);
    });
  });

  it("isolates one item's bookkeeping failure from the rest, then fails the job", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await connectChannel(db, f.orgId, f.clientId, "facebook", "1234567890");
      const good = await approvedItem(db, f.orgId, f.clientId, "facebook", new Date("2026-09-12T08:00:00Z"));
      const bad = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE, { body: "Second" });
      const { social, deps: d } = deps(db);
      // The publisher succeeds for both, but the second item is pulled out from
      // under the sweep before it can be marked — a person cancelled it, say.
      const original = social.publish.bind(social);
      social.publish = async (input) => {
        const result = await original(input);
        if (input.text === "Second") {
          await db.update(schema.contentItems).set({ status: "cancelled" }).where(eq(schema.contentItems.id, bad.id));
        }
        return result;
      };

      await expect(runPublishDue(d, f.orgId, { now: NOW })).rejects.toThrow(AggregateError);

      expect((await itemById(db, good.id)).status).toBe("published");
    });
  });

  it("never claims another organisation's items", async () => {
    await withTestDb(async (db) => {
      const mine = await contentJobFixture(db);
      const theirs = await contentJobFixture(db);
      await connectChannel(db, theirs.orgId, theirs.clientId, "facebook", "999");
      const foreign = await approvedItem(db, theirs.orgId, theirs.clientId, "facebook", DUE);
      const { social, deps: d } = deps(db);

      expect(await runPublishDue(d, mine.orgId, { now: NOW })).toMatchObject({ claimed: 0 });
      expect(social.calls).toEqual([]);
      expect((await itemById(db, foreign.id)).status).toBe("approved");
    });
  });
});

describe("classifyPublishError", () => {
  it("retries what may clear and gives up on what will not", () => {
    expect(classifyPublishError(new SocialRateLimitError("facebook", 429, "x")).retry).toBe(true);
    expect(classifyPublishError(new SocialAuthError("instagram", 190, "x")).retry).toBe(false);
    expect(classifyPublishError(new SocialInvalidMediaError("instagram", 400, "x")).retry).toBe(false);
    expect(classifyPublishError(new WordPressCmsError("request_failed", "500")).retry).toBe(true);
    expect(classifyPublishError(new WordPressCmsError("no_credentials", "no app password")).retry).toBe(false);
    expect(classifyPublishError(new WordPressCmsError("auth_failed", "401")).retry).toBe(false);
    // A pre-flight TypeError from a publisher, or a plain bug: identical next time.
    expect(classifyPublishError(new TypeError("bad location name"))).toEqual({ message: "bad location name", retry: false });
    expect(classifyPublishError("boom")).toEqual({ message: "boom", retry: false });
  });
});
