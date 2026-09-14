import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockReviewsProvider, PlacesRefused, type PlaceReviews, type ReviewsProvider } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  MAX_PUBLISHED_REVIEWS,
  publicSiteReviews,
  publishableReviews,
  refreshSiteReviews,
  setSiteReviewSettings,
  siteReviewsStatus,
  SiteReviewsRefused,
  sitesDueReviewRefresh,
} from "./reviews.js";

const NOW = new Date("2026-09-14T05:10:00Z");

async function siteFixture(db: Db, options: { placeId?: string | null; enabled?: boolean; slug?: string } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `lf-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const [client] = await db
    .insert(schema.clients)
    .values({ organisationId, name: "Nasir Car Home", slug: `nch-${randomUUID()}` })
    .returning();
  const [site] = await db
    .insert(schema.sites)
    .values({
      organisationId,
      clientId: client!.id,
      name: "Nasir Car Home",
      primaryUrl: "https://nasircarhome.example",
      ...(options.slug === undefined ? {} : { slug: options.slug }),
      ...(options.placeId === undefined ? { googlePlaceId: "ChIJ-test-place" } : { googlePlaceId: options.placeId }),
      ...(options.enabled === undefined ? {} : { reviewsEnabled: options.enabled }),
    })
    .returning();
  return { organisationId, clientId: client!.id, site: site! };
}

/** A provider that answers with whatever the test wants, or refuses. */
function providerReturning(answer: PlaceReviews): ReviewsProvider {
  return { name: "stub", fetchPlace: async () => answer };
}
function providerRefusing(refusal: PlacesRefused): ReviewsProvider {
  return {
    name: "stub",
    fetchPlace: async () => {
      throw refusal;
    },
  };
}

const ANSWER: PlaceReviews = {
  name: "Nasir Car Home",
  rating: 4.8,
  count: 137,
  url: "https://maps.google.com/?cid=1",
  reviews: [
    { author: "A Customer", rating: 5, text: "Sorted my clutch same day.", relativeTime: "a month ago", time: 1_750_000_000 },
    { author: "B Customer", rating: 4, text: "Fair price, no upsell.", relativeTime: "2 months ago", time: 1_747_000_000 },
  ],
};

describe("publishableReviews", () => {
  /**
   * A bare star rating is a review to Google and an empty card to a homepage.
   * It still counts towards `count`, which is exactly why the two figures are
   * stored separately.
   */
  it("drops reviews with no words in them", () => {
    const kept = publishableReviews([
      { author: "A", rating: 5, text: "Great work.", relativeTime: "", time: 3 },
      { author: "B", rating: 5, text: "   ", relativeTime: "", time: 2 },
      { author: "C", rating: 4, text: "", relativeTime: "", time: 1 },
    ]);
    expect(kept.map((review) => review.author)).toEqual(["A"]);
  });

  it("puts the newest first and stops at the ceiling", () => {
    const many = Array.from({ length: MAX_PUBLISHED_REVIEWS + 5 }, (_, index) => ({
      author: `A${index}`,
      rating: 5,
      text: "Good.",
      relativeTime: "",
      time: index,
    }));
    const kept = publishableReviews(many);
    expect(kept).toHaveLength(MAX_PUBLISHED_REVIEWS);
    expect(kept[0]!.time).toBeGreaterThan(kept[kept.length - 1]!.time);
  });
});

describe("refreshSiteReviews", () => {
  it("stores Google's own total rather than the number of review bodies", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db);

      const result = await refreshSiteReviews(db, organisationId, providerReturning(ANSWER), {
        siteId: site.id,
        now: NOW,
      });

      // The bug this whole feature invites: a business with 137 ratings being
      // told it has 2 reviews because that is how many bodies Places returned.
      expect(result.count).toBe(137);
      expect(result.stored).toBe(2);

      const row = (await siteReviewsStatus(db, organisationId, site.id))!;
      expect(row.count).toBe(137);
      expect(row.reviews).toHaveLength(2);
      // Text, so 4.0 stays "4.0" instead of rendering as a bare 4 beside
      // four-point-somethings.
      expect(row.rating).toBe("4.8");
      expect(row.fetchedAt).not.toBeNull();
      expect(row.failureReason).toBeNull();
    });
  });

  it("is the same call twice — the refresh button and the nightly sweep", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db);
      await refreshSiteReviews(db, organisationId, providerReturning(ANSWER), { siteId: site.id, now: NOW });
      await refreshSiteReviews(db, organisationId, providerReturning(ANSWER), { siteId: site.id, now: NOW });

      const rows = await db
        .select()
        .from(schema.siteReviews)
        .where(and(eq(schema.siteReviews.organisationId, organisationId), eq(schema.siteReviews.siteId, site.id)));
      expect(rows).toHaveLength(1);
    });
  });

  /**
   * The rule worth protecting: a client's homepage must not go blank because
   * Google had a bad morning. The failure is recorded beside the last good
   * answer, not instead of it.
   */
  it("keeps the last good answer when a later fetch fails", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db, { slug: "nasir-car-home", enabled: true });
      await refreshSiteReviews(db, organisationId, providerReturning(ANSWER), { siteId: site.id, now: NOW });

      const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
      const failed = await refreshSiteReviews(
        db,
        organisationId,
        providerRefusing(new PlacesRefused("not_found", "Google does not recognise that place id.")),
        { siteId: site.id, now: later },
      );
      expect(failed.refreshed).toBe(false);
      expect(failed.reason).toMatch(/does not recognise/);

      const row = (await siteReviewsStatus(db, organisationId, site.id))!;
      expect(row.reviews).toHaveLength(2);
      expect(row.count).toBe(137);
      expect(row.failureReason).toMatch(/does not recognise/);
      expect(row.attemptedAt.getTime()).toBe(later.getTime());
      // Untouched: this is what the public endpoint keeps serving.
      expect(row.fetchedAt!.getTime()).toBe(NOW.getTime());

      const served = await publicSiteReviews(db, "nasir-car-home");
      expect(served!.reviews).toHaveLength(2);
    });
  });

  it("refuses before spending a call when there is no place id", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db, { placeId: null });
      await expect(
        refreshSiteReviews(db, organisationId, new MockReviewsProvider(), { siteId: site.id, now: NOW }),
      ).rejects.toThrow(SiteReviewsRefused);
    });
  });

  it("will not read another organisation's site", async () => {
    await withTestDb(async (db) => {
      const mine = await siteFixture(db);
      const theirs = await siteFixture(db);
      await expect(
        refreshSiteReviews(db, mine.organisationId, new MockReviewsProvider(), { siteId: theirs.site.id, now: NOW }),
      ).rejects.toThrow(SiteReviewsRefused);
    });
  });
});

describe("publicSiteReviews", () => {
  it("answers for an enabled site that has been read", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db, { slug: "nasir-car-home", enabled: true });
      await refreshSiteReviews(db, organisationId, providerReturning(ANSWER), { siteId: site.id, now: NOW });

      const data = (await publicSiteReviews(db, "nasir-car-home"))!;
      expect(data.count).toBe(137);
      expect(data.rating).toBe(4.8);
      expect(data.url).toBe("https://maps.google.com/?cid=1");
      expect(data.fetchedAt).toBe(NOW.toISOString());
      // Unix seconds, which is what a page renders "2 months ago" from in its
      // own language rather than trusting Google's English string.
      expect(data.reviews[0]!.time).toBe(1_750_000_000);
    });
  });

  /**
   * All three of these are the same `null` — and therefore the same plain 404
   * — on purpose. Telling them apart would tell the internet which slugs
   * exist and which clients have the feature switched off, and a client's
   * website hides the band on 404 either way.
   */
  it("is null for an unknown slug, a disabled site, and one never read", async () => {
    await withTestDb(async (db) => {
      const disabled = await siteFixture(db, { slug: "switched-off", enabled: false });
      await refreshSiteReviews(db, disabled.organisationId, providerReturning(ANSWER), {
        siteId: disabled.site.id,
        now: NOW,
      });

      const neverRead = await siteFixture(db, { slug: "never-read", enabled: true });
      expect(neverRead.site.slug).toBe("never-read");

      expect(await publicSiteReviews(db, "no-such-site")).toBeNull();
      expect(await publicSiteReviews(db, "switched-off")).toBeNull();
      expect(await publicSiteReviews(db, "never-read")).toBeNull();
      // Not a slug at all — refused before it reaches the database.
      expect(await publicSiteReviews(db, "Nasir Car Home")).toBeNull();
    });
  });

  it("drops empty-bodied reviews on the way out", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db, { slug: "with-blanks", enabled: true });
      await refreshSiteReviews(
        db,
        organisationId,
        providerReturning({
          ...ANSWER,
          reviews: [...ANSWER.reviews, { author: "Silent", rating: 5, text: "", relativeTime: "", time: 1_751_000_000 }],
        }),
        { siteId: site.id, now: NOW },
      );

      const data = (await publicSiteReviews(db, "with-blanks"))!;
      expect(data.reviews).toHaveLength(2);
      // The silent rating still counts towards Google's total.
      expect(data.count).toBe(137);
    });
  });
});

describe("setSiteReviewSettings", () => {
  it("sets and clears the slug and place id, and audits the change", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db, { placeId: null });

      const on = await setSiteReviewSettings(db, organisationId, {
        siteId: site.id,
        slug: "autocare",
        googlePlaceId: "ChIJ-autocare",
        reviewsEnabled: true,
        actorId: "user-1",
      });
      expect(on.slug).toBe("autocare");
      expect(on.reviewsEnabled).toBe(true);

      const off = await setSiteReviewSettings(db, organisationId, {
        siteId: site.id,
        slug: "",
        googlePlaceId: "",
        reviewsEnabled: false,
      });
      expect(off.slug).toBeNull();
      expect(off.googlePlaceId).toBeNull();

      const audits = await db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.organisationId, organisationId));
      expect(audits.filter((row) => row.action === "site.reviews_settings_changed")).toHaveLength(2);
    });
  });

  /**
   * The reason the slug is per site and not per client: four clients on the
   * live database have two websites each with different Google listings, so a
   * shared handle would answer with the wrong business's reviews.
   */
  it("refuses a slug another site in the same organisation already answers to", async () => {
    await withTestDb(async (db) => {
      const first = await siteFixture(db, { slug: "amo" });
      const [second] = await db
        .insert(schema.sites)
        .values({
          organisationId: first.organisationId,
          clientId: first.clientId,
          name: "AMO Services",
          primaryUrl: "https://amoservices.example",
        })
        .returning();

      await expect(
        setSiteReviewSettings(db, first.organisationId, { siteId: second!.id, slug: "amo" }),
      ).rejects.toThrow();
    });
  });
});

describe("sitesDueReviewRefresh", () => {
  it("takes only enabled sites with a place id, and leaves a fresh one alone", async () => {
    await withTestDb(async (db) => {
      const due = await siteFixture(db, { slug: "due", enabled: true });
      // Same organisation: enabled but no place id, and a place id but disabled.
      await db.insert(schema.sites).values([
        { organisationId: due.organisationId, clientId: due.clientId, name: "No id", primaryUrl: "https://a.example", reviewsEnabled: true },
        { organisationId: due.organisationId, clientId: due.clientId, name: "Off", primaryUrl: "https://b.example", googlePlaceId: "ChIJ-off" },
      ]);

      const before = await sitesDueReviewRefresh(db, due.organisationId, { now: NOW });
      expect(before.map((row) => row.siteId)).toEqual([due.site.id]);

      await refreshSiteReviews(db, due.organisationId, providerReturning(ANSWER), { siteId: due.site.id, now: NOW });
      const justRead = await sitesDueReviewRefresh(db, due.organisationId, { now: NOW });
      expect(justRead).toHaveLength(0);

      const tomorrow = new Date(NOW.getTime() + 21 * 60 * 60 * 1000);
      expect(await sitesDueReviewRefresh(db, due.organisationId, { now: tomorrow })).toHaveLength(1);
    });
  });

  /**
   * Keyed on `attempted_at`, not `fetched_at`. A listing that has been
   * refusing for a week would otherwise look permanently overdue and be
   * retried on every sweep, turning one typo into a daily quota spend.
   */
  it("does not retry a failing listing on every sweep", async () => {
    await withTestDb(async (db) => {
      const { organisationId, site } = await siteFixture(db, { slug: "broken", enabled: true });
      await refreshSiteReviews(
        db,
        organisationId,
        providerRefusing(new PlacesRefused("not_found", "No such place.")),
        { siteId: site.id, now: NOW },
      );

      expect(await sitesDueReviewRefresh(db, organisationId, { now: NOW })).toHaveLength(0);
    });
  });
});
