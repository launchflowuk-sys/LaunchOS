import type { Db } from "@launchos/db";
import type { SitePlatform } from "@launchos/db/schema";
import { schema } from "@launchos/db";
import { markdownToSafeHtml } from "@launchos/integrations";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { SiteSlug } from "../sites/reviews.js";
import { blogDeliveryFor, blogPostSlug } from "./blog-delivery.js";

/**
 * A client application's blog, served by LaunchOS for the application to render.
 *
 * Most of the estate is a Next.js application on Coolify with its own
 * Postgres, not a WordPress install — so there is nothing to push a post
 * *into*. Rather than add a write endpoint and a shared secret to every
 * application, LaunchOS keeps the posts and hands them out here, and each
 * application fetches what it needs. That is the same trade the public reviews
 * endpoint makes, for the same stated reason: a client's site should not have
 * to hold a credential to show its own content.
 *
 * **Scheduling still decides visibility.** Only `published` items are served,
 * and `published` is what the publish sweep sets when an approved post reaches
 * its scheduled time. So "LaunchOS posts to the application on schedule" is
 * true here in exactly the way it is true of WordPress; the difference is
 * which side moves the bytes.
 *
 * **One null for every reason.** An unknown slug, a site whose blog channel is
 * switched off, a deleted site and a WordPress site all answer `null`, which
 * the route turns into a plain 404. Distinguishing them would tell the internet
 * which slugs exist and which clients have the feature on, and an application
 * treats 404 as "no blog here", which is right for all four.
 */

export interface PublicBlogPost {
  /** The content item's id, stable for the life of the post. */
  id: string;
  /** The post's permanent address within the site's own `/blog/`. */
  slug: string;
  title: string;
  /** Sanitised HTML, so no client application needs a markdown renderer of its own. */
  html: string;
  /** The canonical URL on the client's own site, for a self-link or a sitemap. */
  url: string;
  imageUrl: string | null;
  publishedAt: string;
}

export interface PublicSiteBlog {
  /** The site's name in LaunchOS, for a heading the application does not have to hard-code. */
  site: string;
  posts: readonly PublicBlogPost[];
}

/** How many posts one request serves. A year of monthly articles, with room to spare. */
const MAX_POSTS = 50;

/** The site a slug names, if its blog is ours to serve. */
async function servableSite(db: Db, slug: string) {
  const parsed = SiteSlug.safeParse(slug);
  if (!parsed.success) return null;

  const [row] = await db
    .select({
      siteId: schema.sites.id,
      siteName: schema.sites.name,
      primaryUrl: schema.sites.primaryUrl,
      platform: schema.sites.platform,
      clientId: schema.contentChannels.clientId,
      organisationId: schema.contentChannels.organisationId,
    })
    .from(schema.sites)
    // The channel is the switch: a blog channel pointing at this site and
    // enabled is what "this site has a blog" means, so there is no second
    // per-site flag to keep in step with it.
    .innerJoin(
      schema.contentChannels,
      and(
        // `external_id` is text — it holds a Page id or a GBP location name for
        // other channels — so the join needs the cast spelled out.
        eq(schema.contentChannels.externalId, sql`${schema.sites.id}::text`),
        eq(schema.contentChannels.channel, "blog"),
        eq(schema.contentChannels.enabled, true),
        isNull(schema.contentChannels.deletedAt),
      ),
    )
    .where(and(eq(schema.sites.slug, parsed.data), isNull(schema.sites.deletedAt)));

  if (!row) return null;
  // A WordPress site's posts were pushed into WordPress and are served from
  // there. Answering here as well would put the same article on the page twice.
  if (blogDeliveryFor(row.platform) !== "pull") return null;
  return row;
}

/** The URL a post has on the client's own site. */
function canonical(primaryUrl: string, slug: string): string {
  return `${primaryUrl.replace(/\/+$/, "")}/blog/${slug}`;
}

function toPublic(
  row: { id: string; title: string | null; body: string | null; imageUrl: string | null; externalId: string | null; publishedAt: Date | null },
  primaryUrl: string,
): PublicBlogPost {
  // The slug stored when the post was published wins over one derived now, so a
  // link somebody shared still resolves after the title is edited. Posts
  // published before this existed have none, and fall back to the derivation.
  const slug = row.externalId?.trim() || blogPostSlug(row.title, row.id);
  return {
    id: row.id,
    slug,
    title: row.title?.trim() || "Untitled",
    html: markdownToSafeHtml(row.body ?? ""),
    url: canonical(primaryUrl, slug),
    imageUrl: row.imageUrl,
    publishedAt: (row.publishedAt ?? new Date(0)).toISOString(),
  };
}

function publishedPosts(db: Db, site: { organisationId: string; clientId: string }) {
  return db
    .select({
      id: schema.contentItems.id,
      title: schema.contentItems.title,
      body: schema.contentItems.body,
      imageUrl: schema.contentItems.imageUrl,
      externalId: schema.contentItems.externalId,
      publishedAt: schema.contentItems.publishedAt,
    })
    .from(schema.contentItems)
    .where(and(
      eq(schema.contentItems.organisationId, site.organisationId),
      eq(schema.contentItems.clientId, site.clientId),
      eq(schema.contentItems.channel, "blog"),
      eq(schema.contentItems.status, "published"),
      isNull(schema.contentItems.deletedAt),
    ))
    .orderBy(desc(schema.contentItems.publishedAt))
    .limit(MAX_POSTS);
}

/**
 * The site a blog channel points at, so the publish sweep can ask which
 * delivery it gets. `externalId` on a blog channel is a LaunchOS site id, and
 * an id naming a site that has since been deleted is a real state the sweep
 * has to refuse rather than crash on.
 *
 * `slug` comes back nullable because a site record may not have one, and a
 * pulled blog is addressed *by* that slug — so the sweep has to refuse a post
 * for a site without one rather than publish something nothing can fetch.
 */
export async function siteForBlogChannel(
  db: Db,
  organisationId: string,
  siteId: string,
): Promise<{ platform: SitePlatform; primaryUrl: string; slug: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) return null;
  const [row] = await db
    .select({ platform: schema.sites.platform, primaryUrl: schema.sites.primaryUrl, slug: schema.sites.slug })
    .from(schema.sites)
    .where(and(
      eq(schema.sites.id, siteId),
      eq(schema.sites.organisationId, organisationId),
      isNull(schema.sites.deletedAt),
    ));
  return row ?? null;
}

/** Every published blog post for the site a slug names, newest first. */
export async function publicSiteBlog(db: Db, slug: string): Promise<PublicSiteBlog | null> {
  const site = await servableSite(db, slug);
  if (!site) return null;
  const rows = await publishedPosts(db, site);
  return { site: site.siteName, posts: rows.map((row) => toPublic(row, site.primaryUrl)) };
}

/** One post, by the slug it is published under on that site. */
export async function publicSiteBlogPost(
  db: Db,
  slug: string,
  postSlug: string,
): Promise<{ site: string; post: PublicBlogPost } | null> {
  const site = await servableSite(db, slug);
  if (!site) return null;

  const wanted = postSlug.trim().toLowerCase();
  if (!wanted) return null;

  // Matched in code rather than SQL because a post's slug can come from either
  // the stored `externalId` or the derivation, and one query cannot compare
  // against both. The page is capped, so this reads at most `MAX_POSTS` rows.
  const rows = await publishedPosts(db, site);
  const post = rows.map((row) => toPublic(row, site.primaryUrl)).find((p) => p.slug === wanted);
  return post ? { site: site.siteName, post } : null;
}
