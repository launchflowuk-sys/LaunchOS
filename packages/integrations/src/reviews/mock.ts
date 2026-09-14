import { PlaceId, PlacesRefused, type GoogleReview, type PlaceReviews, type ReviewsProvider } from "./types.js";

/**
 * Four obviously-invented reviews, stable per place id.
 *
 * Not pretty on purpose, like every mock in this package: the authors are
 * plainly fictional and the text says so, because a mock that read like real
 * Google reviews could sit on a client's live homepage for a month and nobody
 * would ask why. `adapter-guard.ts` says the same thing at startup.
 *
 * Four rather than five so a test can tell the mock's list from Places' cap,
 * and the count is deliberately far larger than the list — that gap is the
 * bug this whole feature invites (printing `reviews.length` where Google's
 * `user_ratings_total` belongs), so the mock makes it impossible to miss.
 */
const AUTHORS = ["Example Reviewer", "Demo Customer", "Sample Client", "Placeholder Person"] as const;

const MOCK_COUNT = 137;

/** A stable number from a string, so a given listing looks the same every run. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class MockReviewsProvider implements ReviewsProvider {
  readonly name = "mock";

  /** Place ids starting `missing` refuse, so the failure path has a way in. */
  async fetchPlace(placeId: string): Promise<PlaceReviews> {
    const id = PlaceId.parse(placeId);
    if (id.startsWith("missing")) {
      throw new PlacesRefused("not_found", "Google does not recognise that place id (mock).");
    }

    const seed = hash(id);
    const now = Math.floor(Date.now() / 1000);
    const reviews: GoogleReview[] = AUTHORS.map((author, index) => ({
      author,
      rating: 4 + ((seed + index) % 2),
      text: `This is placeholder review text from the mock reviews provider. Nothing here was written by a real customer.`,
      relativeTime: `${index + 1} month${index === 0 ? "" : "s"} ago`,
      // Real seconds, spaced a month apart, so a page rendering "2 months
      // ago" from `time` has something plausible to render.
      time: now - (index + 1) * 30 * 24 * 60 * 60,
    }));

    return {
      name: "Mock Business Listing",
      rating: 4.6,
      count: MOCK_COUNT,
      url: "https://maps.google.com/?cid=0",
      reviews,
    };
  }
}
