import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { setEnqueue } from "../events/emit.js";
import { packageUsagePressure } from "../billing/package-usage.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { setContentChannel } from "./channels.js";
import { FAN_OUT_CHANNELS, fanOutBody, fanOutPublishedPost, fanOutSchedule } from "./fan-out.js";

setEnqueue(async () => {});

const PUBLISHED = new Date("2026-09-07T14:12:00Z");
const URL = "https://chaudarybuilders.co.uk/blog/five-signs-you-need-new-windows";

/** The month the allowance is measured in, so a fixed date does not drift. */
function periodKeyOf(when: Date): string {
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A published blog post, the thing a fan-out starts from. */
async function publishedBlogPost(
  db: Parameters<typeof fanOutPublishedPost>[0],
  organisationId: string,
  clientId: string,
  overrides: Partial<typeof schema.contentItems.$inferInsert> = {},
) {
  const [row] = await db.insert(schema.contentItems).values({
    organisationId, clientId,
    channel: "blog", kind: "blog_post", status: "published",
    periodKey: periodKeyOf(PUBLISHED),
    title: "Five signs you need new windows",
    body: "…",
    externalUrl: URL,
    publishedAt: PUBLISHED,
    ...overrides,
  }).returning();
  return row!;
}

async function connect(db: Parameters<typeof fanOutPublishedPost>[0], organisationId: string, clientId: string, channels: readonly string[]) {
  for (const channel of channels) {
    await setContentChannel(db, organisationId, {
      clientId, channel: channel as "facebook", externalId: `ext-${randomUUID()}`, enabled: true,
    });
  }
}

describe("fanOutSchedule", () => {
  it("puts the share the next morning rather than the same minute as the article", () => {
    const when = fanOutSchedule(PUBLISHED);
    expect(when.toISOString()).toBe("2026-09-08T08:30:00.000Z");
  });
});

describe("fanOutBody", () => {
  it("carries the headline and the link, worded for where it lands", () => {
    expect(fanOutBody("facebook", "Five signs you need new windows", URL)).toContain(URL);
    expect(fanOutBody("gbp", "Five signs you need new windows", URL)).toContain("New on our blog");
    expect(fanOutBody("facebook", null, URL)).toContain("a new post");
  });
});

describe("fanOutPublishedPost", () => {
  it("shares to Facebook and GBP, as drafts, pointing at the article", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await connect(db, organisationId, clientId, ["facebook", "gbp", "instagram"]);
      const post = await publishedBlogPost(db, organisationId, clientId);

      const { created } = await fanOutPublishedPost(db, organisationId, post);

      expect(created.map((c) => c.channel).sort()).toEqual(["facebook", "gbp"]);
      for (const share of created) {
        // A draft, not a scheduled post: it still faces the approval gate.
        expect(share.status).toBe("draft");
        expect(share.linkUrl).toBe(URL);
        expect(share.body).toContain(URL);
        expect(share.sourceItemId).toBe(post.id);
        expect(share.scheduledFor?.toISOString()).toBe("2026-09-08T08:30:00.000Z");
      }
    });
  });

  it("leaves Instagram out on purpose — a caption link is not clickable", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await connect(db, organisationId, clientId, ["facebook", "instagram"]);
      const post = await publishedBlogPost(db, organisationId, clientId);

      const { created } = await fanOutPublishedPost(db, organisationId, post);
      expect(created.map((c) => c.channel)).toEqual(["facebook"]);
      expect(FAN_OUT_CHANNELS).not.toContain("instagram");
    });
  });

  it("only shares where the client actually has the channel connected", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await connect(db, organisationId, clientId, ["gbp"]);
      const post = await publishedBlogPost(db, organisationId, clientId);

      const { created } = await fanOutPublishedPost(db, organisationId, post);
      expect(created.map((c) => c.channel)).toEqual(["gbp"]);
    });
  });

  it("does it once, however many times it is called", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await connect(db, organisationId, clientId, ["facebook", "gbp"]);
      const post = await publishedBlogPost(db, organisationId, clientId);

      const first = await fanOutPublishedPost(db, organisationId, post);
      const second = await fanOutPublishedPost(db, organisationId, post);

      expect(first.created).toHaveLength(2);
      expect(second.created).toHaveLength(0);
      expect(second.skipped).toBe("already_fanned_out");

      const all = await db.select().from(schema.contentItems).where(and(
        eq(schema.contentItems.organisationId, organisationId),
        eq(schema.contentItems.sourceItemId, post.id),
      ));
      expect(all).toHaveLength(2);
    });
  });

  it("has nothing to do for a post with no permalink, or for anything that is not an article", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      await connect(db, organisationId, clientId, ["facebook", "gbp"]);

      const noUrl = await publishedBlogPost(db, organisationId, clientId, { externalUrl: null });
      expect((await fanOutPublishedPost(db, organisationId, noUrl)).skipped).toBe("no_permalink");

      const social = await publishedBlogPost(db, organisationId, clientId, { channel: "facebook", kind: "social_post" });
      expect((await fanOutPublishedPost(db, organisationId, social)).skipped).toBe("not_a_blog_post");
    });
  });

  it("does not spend the client's social allowance — the article was what they paid for", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      // Two social posts a month, and one of them already used.
      await db.update(schema.packages).set({
        includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 2, blogPostsPerMonth: 4, gbpUpdatesPerMonth: 4 },
      }).where(eq(schema.packages.id, packageId));
      await db.insert(schema.contentItems).values({
        organisationId, clientId, channel: "facebook", kind: "social_post", status: "published",
        periodKey: periodKeyOf(PUBLISHED), body: "the one they paid for", publishedAt: PUBLISHED,
      });

      await connect(db, organisationId, clientId, ["facebook", "gbp"]);
      const post = await publishedBlogPost(db, organisationId, clientId, { periodKey: periodKeyOf(PUBLISHED) });
      const { created } = await fanOutPublishedPost(db, organisationId, post);
      expect(created).toHaveLength(2);

      // Publish the shares, so they would be counted if they were counted.
      for (const share of created) {
        await db.update(schema.contentItems)
          .set({ status: "published", publishedAt: PUBLISHED })
          .where(eq(schema.contentItems.id, share.id));
      }

      const pressure = await packageUsagePressure(db, organisationId, { now: PUBLISHED });
      const mine = pressure.filter((c) => c.clientId === clientId);
      const social = mine.flatMap((c) => c.allowances).filter((a) => a.label === "Social posts");

      // Counted, the Facebook share would make it 2 of 2 and the client would be
      // named as at their limit. Ignored, it stays at the one they paid for and
      // there is nothing to report.
      for (const allowance of social) expect(allowance.used).toBe(1);
      expect(mine.some((c) => c.standing === "over")).toBe(false);
    });
  });
});
