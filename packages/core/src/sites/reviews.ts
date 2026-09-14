import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { StoredGoogleReview } from "@launchos/db/schema";
import { PlacesRefused, type ReviewsProvider } from "@launchos/integrations";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

/**
 * A client's Google reviews, fetched by us and served to their own website.
 *
 * The point of this existing at all: a client's site shows its Google reviews
 * without holding a Google key, without a plugin, and without the site author
 * writing any integration. LaunchOS already knows every client site, so it
 * does the asking once a day and hands the answer over on a public URL.
 *
 * Three rules the whole module turns on.
 *
 * **`count` is Google's `user_ratings_total`, never `reviews.length`.** Places
 * Details returns at most five review bodies whatever the listing holds, so a
 * client with four hundred reviews would be told they have five. The two
 * numbers are stored separately and only one of them is the headline.
 *
 * **A failed refresh keeps the last good answer.** `fetched_at` and
 * `failure_reason` are both on the row, and the reviews are not cleared on
 * failure. A listing that goes unreadable for a fortnight should keep serving
 * a client's homepage from last week's copy rather than blank the band —
 * stale reviews are worth more than no reviews, and the staleness is visible
 * to us on the admin screen where the decision belongs.
 *
 * **Nothing is fetched until somebody enables it.** `reviews_enabled`
 * defaults to false and a place id being present is not consent: publishing
 * another business's reviews on a client's homepage is the failure mode worth
 * engineering against, and the place id is typed by hand.
 */

/**
 * What a homepage band shows. Google returns five; the client sites render up
 * to six on desktop, so everything available is passed on and the site takes
 * what it needs.
 *
 * Raising this does not get more out of Places — the cap is the provider's.
 * Business Profile OAuth is what lifts it, and when it does this is the
 * constant that changes.
 */
export const MAX_PUBLISHED_REVIEWS = 12;

/** How stale a stored answer may be before the daily sweep asks again. */
export const REVIEWS_REFRESH_AFTER_HOURS = 20;

export class SiteReviewsRefused extends Error {
  constructor(
    readonly reason: "not_found" | "no_place_id" | "fetch_failed",
    message: string,
  ) {
    super(message);
    this.name = "SiteReviewsRefused";
  }
}

/**
 * A slug a client's website will put in a query string.
 *
 * Lowercase, hyphenated, no spaces — it travels in a URL and appears in
 * another team's environment variable, so a value that needs escaping is a
 * support call. Per site rather than per client because four clients on the
 * live database have two sites each with different Google listings behind
 * them; see the note on `sites.slug`.
 */
export const SiteSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a slug is lowercase letters, numbers and single hyphens");

export const SiteReviewSettingsInput = z.object({
  siteId: z.string().uuid(),
  /** Empty string clears it. */
  slug: z.union([z.literal(""), SiteSlug]).optional(),
  googlePlaceId: z.union([z.literal(""), z.string().trim().min(5).max(400)]).optional(),
  reviewsEnabled: z.boolean().optional(),
  actorId: z.string().optional(),
});
export type SiteReviewSettingsInput = z.input<typeof SiteReviewSettingsInput>;

type SiteRow = typeof schema.sites.$inferSelect;
type SiteReviewsRow = typeof schema.siteReviews.$inferSelect;

async function requireSite(db: Db, organisationId: string, siteId: string): Promise<SiteRow> {
  const [site] = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId), isNull(schema.sites.deletedAt)));
  if (!site) throw new SiteReviewsRefused("not_found", "That website could not be found.");
  return site;
}

/**
 * Sets the slug, the place id and the switch.
 *
 * Audited, because switching reviews on is the moment a third party's words
 * start appearing on a client's homepage on our say-so, and because a
 * mistyped place id publishes the wrong company — both are things somebody
 * will one day need to see the history of.
 */
export async function setSiteReviewSettings(
  db: Db,
  organisationId: string,
  input: SiteReviewSettingsInput,
): Promise<SiteRow> {
  const v = SiteReviewSettingsInput.parse(input);
  const before = await requireSite(db, organisationId, v.siteId);

  const [after] = await db
    .update(schema.sites)
    .set({
      ...(v.slug === undefined ? {} : { slug: v.slug === "" ? null : v.slug }),
      ...(v.googlePlaceId === undefined ? {} : { googlePlaceId: v.googlePlaceId === "" ? null : v.googlePlaceId }),
      ...(v.reviewsEnabled === undefined ? {} : { reviewsEnabled: v.reviewsEnabled }),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.sites.id, v.siteId), eq(schema.sites.organisationId, organisationId)))
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: v.actorId,
    action: "site.reviews_settings_changed",
    targetType: "site",
    targetId: v.siteId,
    before,
    after: after!,
  });
  return after!;
}

/**
 * Trims a provider's answer to what is published.
 *
 * A review with no body is dropped — Google counts a bare star rating as a
 * review and a homepage cannot render one, so a band of blank cards is the
 * alternative. They still count towards `count`, which is Google's own total
 * and is exactly why the two are separate.
 *
 * Newest first, because that is the order a reviews band reads in and the
 * order the client sites expect to be able to truncate.
 */
export function publishableReviews(reviews: readonly StoredGoogleReview[]): StoredGoogleReview[] {
  return [...reviews]
    .filter((review) => review.text.trim().length > 0)
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_PUBLISHED_REVIEWS);
}

export interface RefreshSiteReviewsResult {
  siteId: string;
  refreshed: boolean;
  /** How many review bodies are now stored. Not the rating count. */
  stored: number;
  count: number;
  rating: number | null;
  reason?: string;
}

/**
 * Asks Google about one site's listing and stores the answer.
 *
 * Idempotent by nature — it overwrites — so the "refresh now" button and the
 * nightly sweep are the same call. Refusals are *recorded and returned*, not
 * thrown: the sweep runs over every site and one dead place id must not stop
 * the rest, and the reason has to reach the admin screen or nobody ever fixes
 * the typo.
 */
export async function refreshSiteReviews(
  db: Db,
  organisationId: string,
  provider: ReviewsProvider,
  input: { siteId: string; now?: Date },
): Promise<RefreshSiteReviewsResult> {
  const siteId = z.string().uuid().parse(input.siteId);
  const now = input.now ?? new Date();
  const site = await requireSite(db, organisationId, siteId);

  if (!site.googlePlaceId) {
    throw new SiteReviewsRefused("no_place_id", "Add the Google place id for this site before refreshing its reviews.");
  }

  const record = async (values: Partial<SiteReviewsRow>) => {
    await db
      .insert(schema.siteReviews)
      .values({ organisationId, siteId, attemptedAt: now, ...values })
      .onConflictDoUpdate({
        target: schema.siteReviews.siteId,
        set: { attemptedAt: now, updatedAt: now, ...values },
      });
  };

  let answer;
  try {
    answer = await provider.fetchPlace(site.googlePlaceId);
  } catch (error) {
    const reason = error instanceof PlacesRefused ? error.message : "Could not read that listing.";
    // Only the failure is written. The stored reviews, rating, count and
    // `fetched_at` are all left alone, so the public endpoint keeps serving
    // the last good answer.
    await record({ failureReason: reason });
    return { siteId, refreshed: false, stored: 0, count: 0, rating: null, reason };
  }

  const stored: StoredGoogleReview[] = answer.reviews.map((review) => ({
    author: review.author,
    rating: review.rating,
    text: review.text,
    relativeTime: review.relativeTime,
    time: review.time,
    ...(review.profilePhotoUrl ? { profilePhotoUrl: review.profilePhotoUrl } : {}),
  }));

  await record({
    // Stored as text so a rating of 4.0 stays "4.0" rather than becoming 4 and
    // rendering as a whole number beside four-point-somethings.
    rating: answer.rating === null ? null : answer.rating.toFixed(1),
    count: answer.count,
    reviews: stored,
    googleUrl: answer.url,
    fetchedAt: now,
    failureReason: null,
  });

  return { siteId, refreshed: true, stored: stored.length, count: answer.count, rating: answer.rating };
}

export interface PublicSiteReviews {
  name: string;
  rating: number | null;
  count: number;
  url: string | null;
  fetchedAt: string | null;
  reviews: readonly StoredGoogleReview[];
}

/**
 * What the public endpoint answers with, by slug.
 *
 * Null for an unknown slug, a site with reviews switched off, and a site that
 * has never had a successful fetch — all three are a plain 404 to the caller,
 * because the alternative is telling the internet which slugs exist and which
 * clients have reviews disabled. A client's website treats 404 as "hide the
 * band", which is the correct behaviour for every one of those cases anyway.
 *
 * The listing's **own** Google name is returned rather than the site's name in
 * LaunchOS: the band says "137 Google reviews" beside it and the name should
 * be the one on the listing those reviews belong to.
 */
export async function publicSiteReviews(
  db: Db,
  slug: string,
): Promise<PublicSiteReviews | null> {
  const parsed = SiteSlug.safeParse(slug);
  if (!parsed.success) return null;

  const [row] = await db
    .select({
      siteName: schema.sites.name,
      rating: schema.siteReviews.rating,
      count: schema.siteReviews.count,
      reviews: schema.siteReviews.reviews,
      googleUrl: schema.siteReviews.googleUrl,
      fetchedAt: schema.siteReviews.fetchedAt,
    })
    .from(schema.sites)
    .innerJoin(
      schema.siteReviews,
      and(eq(schema.siteReviews.siteId, schema.sites.id), isNull(schema.siteReviews.deletedAt)),
    )
    .where(and(
      eq(schema.sites.slug, parsed.data),
      eq(schema.sites.reviewsEnabled, true),
      isNull(schema.sites.deletedAt),
    ));

  if (!row || row.fetchedAt === null) return null;

  return {
    name: row.siteName,
    rating: row.rating === null ? null : Number(row.rating),
    count: row.count,
    url: row.googleUrl,
    fetchedAt: row.fetchedAt.toISOString(),
    reviews: publishableReviews(row.reviews),
  };
}

export interface SiteDueReviewRefresh {
  siteId: string;
  organisationId: string;
  name: string;
}

/**
 * The sites the nightly sweep should ask about: reviews on, a place id set,
 * and either never fetched or last *attempted* more than
 * `REVIEWS_REFRESH_AFTER_HOURS` ago.
 *
 * Keyed on `attempted_at` rather than `fetched_at` deliberately. A listing
 * that has been refusing for a week would otherwise look permanently overdue
 * and be retried on every sweep, turning one typo into a daily quota spend.
 */
export async function sitesDueReviewRefresh(
  db: Db,
  organisationId: string,
  options: { now?: Date; hours?: number } = {},
): Promise<SiteDueReviewRefresh[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.hours ?? REVIEWS_REFRESH_AFTER_HOURS) * 60 * 60 * 1000);

  return db
    .select({ siteId: schema.sites.id, organisationId: schema.sites.organisationId, name: schema.sites.name })
    .from(schema.sites)
    .leftJoin(schema.siteReviews, eq(schema.siteReviews.siteId, schema.sites.id))
    .where(and(
      eq(schema.sites.organisationId, organisationId),
      eq(schema.sites.reviewsEnabled, true),
      isNull(schema.sites.deletedAt),
      isNotNull(schema.sites.googlePlaceId),
      // Drizzle's own operators rather than a `sql` template: a bare `${date}`
      // in one has no column type to be bound against, and postgres.js
      // refuses a Date it cannot serialise.
      or(isNull(schema.siteReviews.attemptedAt), lt(schema.siteReviews.attemptedAt, cutoff)),
    ));
}

/** The stored row for one site, for the admin screen. Null when never attempted. */
export async function siteReviewsStatus(db: Db, organisationId: string, siteId: string): Promise<SiteReviewsRow | null> {
  const [row] = await db
    .select()
    .from(schema.siteReviews)
    .where(and(
      eq(schema.siteReviews.siteId, siteId),
      eq(schema.siteReviews.organisationId, organisationId),
      isNull(schema.siteReviews.deletedAt),
    ));
  return row ?? null;
}
