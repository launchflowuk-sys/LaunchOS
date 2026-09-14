import { describe, expect, it } from "vitest";
import { createReviewsProviderFromEnv, GooglePlacesProvider, MockReviewsProvider, PlacesRefused } from "./index.js";

/** A `fetch` that answers with one canned Places payload and records the URL. */
function stubFetch(body: unknown, status = 200): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: unknown) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: impl, urls };
}

const OK_BODY = {
  status: "OK",
  result: {
    name: "Nasir Car Home",
    rating: 4.8,
    user_ratings_total: 137,
    url: "https://maps.google.com/?cid=1",
    reviews: [
      {
        author_name: "A Customer",
        rating: 5,
        text: "Sorted my clutch same day.",
        relative_time_description: "a month ago",
        time: 1_750_000_000,
        profile_photo_url: "https://lh3.googleusercontent.com/a/abc",
      },
      {
        author_name: "B Customer",
        rating: 4,
        text: "Fair price.",
        relative_time_description: "2 months ago",
        time: 1_747_000_000,
      },
    ],
  },
};

describe("GooglePlacesProvider", () => {
  /**
   * The mistake this whole feature invites. Google returns at most five review
   * bodies whatever the listing holds, so `reviews.length` as the headline
   * would tell a garage with 137 ratings that it has two reviews.
   */
  it("takes count from user_ratings_total, not from the reviews array", async () => {
    const { fetch } = stubFetch(OK_BODY);
    const answer = await new GooglePlacesProvider({ apiKey: "k" }, { fetch }).fetchPlace("ChIJ-test");

    expect(answer.count).toBe(137);
    expect(answer.reviews).toHaveLength(2);
    expect(answer.rating).toBe(4.8);
    expect(answer.url).toBe("https://maps.google.com/?cid=1");
  });

  it("asks only for the fields it uses, and sends the key", async () => {
    const { fetch, urls } = stubFetch(OK_BODY);
    await new GooglePlacesProvider({ apiKey: "secret-key" }, { fetch }).fetchPlace("ChIJ-test");

    const url = new URL(urls[0]!);
    // Places bills per field group; an extra field here is money for nothing.
    expect(url.searchParams.get("fields")).toBe("name,rating,user_ratings_total,reviews,url");
    expect(url.searchParams.get("place_id")).toBe("ChIJ-test");
    expect(url.searchParams.get("key")).toBe("secret-key");
    expect(url.searchParams.get("language")).toBe("en-GB");
  });

  it("keeps time in Unix seconds and only https profile photos", async () => {
    const { fetch } = stubFetch(OK_BODY);
    const answer = await new GooglePlacesProvider({ apiKey: "k" }, { fetch }).fetchPlace("ChIJ-test");

    expect(answer.reviews[0]!.time).toBe(1_750_000_000);
    expect(answer.reviews[0]!.profilePhotoUrl).toBe("https://lh3.googleusercontent.com/a/abc");
    // Absent rather than an empty string, so the field can simply be omitted.
    expect(answer.reviews[1]!.profilePhotoUrl).toBeUndefined();
  });

  /**
   * Other people's JSON. One odd entry must not cost a client their whole
   * reviews band — and a missing `time` becoming `NaN` would render as
   * "53 years ago" on their homepage.
   */
  it("drops a malformed review and keeps the rest", async () => {
    const { fetch } = stubFetch({
      status: "OK",
      result: {
        name: "X",
        rating: 4,
        user_ratings_total: 9,
        url: "https://maps.google.com/?cid=2",
        reviews: [
          { author_name: "Good", rating: 5, text: "Fine.", relative_time_description: "a week ago", time: 1_750_000_000 },
          { author_name: "No time", rating: 5, text: "Fine." },
          { rating: 5, text: "No author.", time: 1_750_000_000 },
          { author_name: "Out of range", rating: 9, text: "Nine stars.", time: 1_750_000_000 },
          "not an object",
        ],
      },
    });

    const answer = await new GooglePlacesProvider({ apiKey: "k" }, { fetch }).fetchPlace("ChIJ-test");
    expect(answer.reviews.map((review) => review.author)).toEqual(["Good"]);
    // The count is Google's and is unaffected by our parsing.
    expect(answer.count).toBe(9);
  });

  it("reads a listing with ratings but no review bodies", async () => {
    const { fetch } = stubFetch({
      status: "OK",
      result: { name: "Quiet", rating: 5, user_ratings_total: 12, url: "https://maps.google.com/?cid=3" },
    });
    const answer = await new GooglePlacesProvider({ apiKey: "k" }, { fetch }).fetchPlace("ChIJ-test");
    expect(answer.count).toBe(12);
    expect(answer.reviews).toEqual([]);
  });

  it("reads a brand new listing with no rating at all", async () => {
    const { fetch } = stubFetch({ status: "OK", result: { name: "New", user_ratings_total: 0, reviews: [] } });
    const answer = await new GooglePlacesProvider({ apiKey: "k" }, { fetch }).fetchPlace("ChIJ-test");
    expect(answer.rating).toBeNull();
    expect(answer.count).toBe(0);
    expect(answer.url).toBeNull();
  });

  /**
   * The sweep needs to tell a typo from a bad morning: one will never succeed
   * and the other should be tried again tomorrow.
   */
  it("separates a wrong place id from a temporary failure", async () => {
    const notFound = stubFetch({ status: "NOT_FOUND" });
    await expect(
      new GooglePlacesProvider({ apiKey: "k" }, { fetch: notFound.fetch }).fetchPlace("ChIJ-test"),
    ).rejects.toMatchObject({ reason: "not_found", retryable: false });

    const denied = stubFetch({ status: "REQUEST_DENIED", error_message: "API key not authorised" });
    await expect(
      new GooglePlacesProvider({ apiKey: "k" }, { fetch: denied.fetch }).fetchPlace("ChIJ-test"),
    ).rejects.toMatchObject({ reason: "denied", retryable: false });

    const quota = stubFetch({ status: "OVER_QUERY_LIMIT" });
    await expect(
      new GooglePlacesProvider({ apiKey: "k" }, { fetch: quota.fetch }).fetchPlace("ChIJ-test"),
    ).rejects.toMatchObject({ reason: "over_quota", retryable: true });
  });

  it("turns an unreachable Google into a refusal rather than a raw network error", async () => {
    const impl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    await expect(
      new GooglePlacesProvider({ apiKey: "k" }, { fetch: impl }).fetchPlace("ChIJ-test"),
    ).rejects.toThrow(PlacesRefused);
  });

  it("refuses a non-JSON answer instead of throwing a parse error", async () => {
    const impl = (async () => new Response("<html>502</html>", { status: 200 })) as typeof fetch;
    await expect(
      new GooglePlacesProvider({ apiKey: "k" }, { fetch: impl }).fetchPlace("ChIJ-test"),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
});

describe("createReviewsProviderFromEnv", () => {
  it("uses Google when a key is set and the mock when it is not", () => {
    expect(createReviewsProviderFromEnv({ GOOGLE_MAPS_API_KEY: "k" }).name).toBe("google-places");
    expect(createReviewsProviderFromEnv({}).name).toBe("mock");
    // A blank or whitespace value is unset, not a key.
    expect(createReviewsProviderFromEnv({ GOOGLE_MAPS_API_KEY: "   " }).name).toBe("mock");
  });
});

describe("MockReviewsProvider", () => {
  it("is obviously fake, and its count is nothing like its review list", async () => {
    const answer = await new MockReviewsProvider().fetchPlace("ChIJ-anything");
    expect(answer.reviews.length).toBeLessThan(answer.count);
    expect(answer.reviews[0]!.text).toMatch(/placeholder/i);
    // Real seconds, so a page rendering "2 months ago" has something plausible.
    expect(answer.reviews[0]!.time).toBeGreaterThan(1_600_000_000);
  });

  it("gives the failure path a way in", async () => {
    await expect(new MockReviewsProvider().fetchPlace("missing-place")).rejects.toThrow(PlacesRefused);
  });
});
