import { z } from "zod";

/**
 * Somebody else's opinion of a client's business, fetched from Google.
 *
 * This package reports what the provider said and never decides what to do
 * with it — no storing, no trimming to a homepage's taste, no pricing. Google
 * caps Places Details at five reviews and that cap is the provider's, so it is
 * described here and enforced nowhere: a provider that one day returns more
 * (Business Profile OAuth will) must not be silently truncated by the layer
 * whose only job is to ask.
 */

/** What Places Details returns at most, whatever the listing actually has. */
export const PLACES_REVIEW_CAP = 5;

/** A listing id is opaque to us; only its shape is worth checking before spending a call. */
export const PlaceId = z.string().trim().min(5).max(400);

export const GoogleReview = z.object({
  author: z.string(),
  /** Google's stars for this one review, 1–5 whole numbers. */
  rating: z.number().int().min(1).max(5),
  text: z.string(),
  /** Google's pre-rendered English string, e.g. "2 months ago". A fallback, never the source. */
  relativeTime: z.string(),
  /** Unix **seconds**, Places' own unit. The thing a localised "2 months ago" is computed from. */
  time: z.number().int().nonnegative(),
  profilePhotoUrl: z.string().url().optional(),
});
export type GoogleReview = z.infer<typeof GoogleReview>;

export const PlaceReviews = z.object({
  /** The listing's display name, as Google has it. */
  name: z.string(),
  /** The average, one decimal, or null when the listing has no ratings at all. */
  rating: z.number().min(0).max(5).nullable(),
  /** `user_ratings_total`: every rating, not the number of bodies below. */
  count: z.number().int().nonnegative(),
  /** The listing's Google Maps URL. */
  url: z.string().url().nullable(),
  reviews: z.array(GoogleReview),
});
export type PlaceReviews = z.infer<typeof PlaceReviews>;

/**
 * Thrown when the provider answered and the answer was no.
 *
 * Separate from a network failure on purpose: `NOT_FOUND` on a place id means
 * somebody typed it wrong and no amount of retrying will help, while a timeout
 * should be tried again tomorrow. The daily sweep needs to tell those apart to
 * decide whether a human should be told.
 */
export class PlacesRefused extends Error {
  constructor(
    readonly reason: "not_found" | "denied" | "over_quota" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PlacesRefused";
  }

  /** Whether trying the same id again could plausibly succeed. */
  get retryable(): boolean {
    return this.reason === "over_quota" || this.reason === "unavailable";
  }
}

export interface ReviewsProvider {
  readonly name: string;
  /** Everything a homepage band needs about one listing, in one call. */
  fetchPlace(placeId: string): Promise<PlaceReviews>;
}
