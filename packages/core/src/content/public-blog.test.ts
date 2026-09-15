import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { publicSiteBlog, publicSiteBlogPost } from "./public-blog.js";

const JULY = new Date("2026-07-10T09:00:00Z");
const AUGUST = new Date("2026-08-10T09:00:00Z");

async function fixture(db: Db, opts: { platform?: "wordpress" | "nextjs" } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `pb-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "LifeStyle Windows", slug: `lsw-${randomUUID()}`,
  }).returning();
  const slug = `lifestyle-${randomUUID().slice(0, 8)}`;
  const [site] = await db.insert(schema.sites).values({
    organisationId: org!.id, clientId: client!.id, name: "LifeStyle Windows",
    slug, primaryUrl: "https://lifestylewindows.example", platform: opts.platform ?? "nextjs",
  }).returning();
  await db.insert(schema.contentChannels).values({
    organisationId: org!.id, clientId: client!.id, channel: "blog", externalId: site!.id, enabled: true,
  });

  const post = async (values: Partial<typeof schema.contentItems.$inferInsert> = {}) => {
    const [row] = await db.insert(schema.contentItems).values({
      organisationId: org!.id, clientId: client!.id, channel: "blog", kind: "blog_post",
      periodKey: "2026-08", status: "published", title: "Five signs your windows need replacing",
      body: "## Draughts\n\nA draught you can feel is a seal that has gone.",
      publishedAt: AUGUST, scheduledFor: AUGUST, ...values,
    }).returning();
    return row!;
  };

  return { organisationId: org!.id, clientId: client!.id, siteId: site!.id, slug, post };
}

describe("publicSiteBlog", () => {
  it("serves a published post as sanitised HTML, newest first", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await f.post({ title: "Older", publishedAt: JULY, periodKey: "2026-07" });
      await f.post({ title: "Newer", publishedAt: AUGUST });

      const answer = await publicSiteBlog(db, f.slug);

      expect(answer?.site).toBe("LifeStyle Windows");
      expect(answer?.posts.map((p) => p.title)).toEqual(["Newer", "Older"]);
      // HTML, not markdown: otherwise every client application needs its own
      // renderer, which is the same mistake as every one needing its own secret.
      expect(answer?.posts[0]?.html).toContain("<h2>Draughts</h2>");
      expect(answer?.posts[0]?.html).not.toContain("## Draughts");
      expect(answer?.posts[0]?.slug).toMatch(/^newer-/);
    });
  });

  /**
   * The scheduling promise. A post whose moment has not come is not visible,
   * because the endpoint serves `published` only — which is what the publish
   * sweep sets, at the scheduled time.
   */
  it("hides everything that is not published", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await f.post({ title: "A draft", status: "draft" });
      await f.post({ title: "Waiting on approval", status: "awaiting_approval" });
      await f.post({ title: "Approved but not yet due", status: "approved" });

      const answer = await publicSiteBlog(db, f.slug);
      expect(answer?.posts).toEqual([]);
    });
  });

  /** Only this site's blog: social posts and another site's articles are not it. */
  it("returns nothing but this site's blog posts", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await f.post({ title: "The article" });
      await f.post({ title: "A Facebook post", channel: "facebook", kind: "social_post" });

      const other = await fixture(db);
      await other.post({ title: "Somebody else's article" });

      const answer = await publicSiteBlog(db, f.slug);
      expect(answer?.posts.map((p) => p.title)).toEqual(["The article"]);
    });
  });

  /**
   * One 404 for every reason, as the reviews endpoint does: an unknown slug, a
   * disabled channel and a WordPress site all answer the same. Distinguishing
   * them would tell the internet which slugs exist.
   */
  it("is null for an unknown slug, a disabled channel and a deleted site", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await f.post();
      expect(await publicSiteBlog(db, "no-such-site")).toBeNull();
      expect(await publicSiteBlog(db, "!! not a slug")).toBeNull();

      await db.update(schema.contentChannels).set({ enabled: false })
        .where(eq(schema.contentChannels.clientId, f.clientId));
      expect(await publicSiteBlog(db, f.slug)).toBeNull();

      await db.update(schema.contentChannels).set({ enabled: true })
        .where(eq(schema.contentChannels.clientId, f.clientId));
      await db.update(schema.sites).set({ deletedAt: new Date() }).where(eq(schema.sites.id, f.siteId));
      expect(await publicSiteBlog(db, f.slug)).toBeNull();
    });
  });

  /**
   * A WordPress site's posts live in WordPress. Serving them here as well
   * would put the same article on the site twice, from two sources.
   */
  it("is null for a WordPress site, whose posts are pushed into it instead", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { platform: "wordpress" });
      await f.post();
      expect(await publicSiteBlog(db, f.slug)).toBeNull();
    });
  });

  it("serves the site's own canonical url so a post can link to itself", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const row = await f.post();
      const answer = await publicSiteBlog(db, f.slug);
      expect(answer?.posts[0]?.url).toBe(`https://lifestylewindows.example/blog/${answer!.posts[0]!.slug}`);
      expect(answer?.posts[0]?.id).toBe(row.id);
    });
  });

  /** A post published before this feature existed has no stored slug; it still needs an address. */
  it("derives a slug when the published item never stored one", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const row = await f.post({ title: "Legacy post", externalId: null });
      const answer = await publicSiteBlog(db, f.slug);
      expect(answer?.posts[0]?.slug).toBe(`legacy-post-${row.id.replace(/-/g, "").slice(0, 8)}`);
    });
  });

  /** The stored slug wins, so a link shared before a title was edited still resolves. */
  it("prefers the slug stored at publish time over one derived from the current title", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await f.post({ title: "Retitled since", externalId: "the-original-title-abcdef01" });
      const answer = await publicSiteBlog(db, f.slug);
      expect(answer?.posts[0]?.slug).toBe("the-original-title-abcdef01");
    });
  });
});

describe("publicSiteBlogPost", () => {
  it("serves one post by its slug", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await f.post({ title: "Wanted", externalId: "wanted-00000001" });
      await f.post({ title: "Not wanted", externalId: "not-wanted-00000002" });

      const found = await publicSiteBlogPost(db, f.slug, "wanted-00000001");
      expect(found?.post.title).toBe("Wanted");
      expect(found?.site).toBe("LifeStyle Windows");
      expect(await publicSiteBlogPost(db, f.slug, "nothing-here")).toBeNull();
    });
  });

  it("will not serve a post from a different site with the same slug", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db);
      await theirs.post({ title: "Theirs", externalId: "shared-slug-00000001" });

      expect(await publicSiteBlogPost(db, mine.slug, "shared-slug-00000001")).toBeNull();
      expect(await publicSiteBlogPost(db, theirs.slug, "shared-slug-00000001")).not.toBeNull();
    });
  });
});
