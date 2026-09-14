import { PlaceId, PlaceReviews, PlacesRefused, type GoogleReview, type ReviewsProvider } from "./types.js";

export const PLACES_ENDPOINT = "https://maps.googleapis.com/maps/api/place/details/json";

/**
 * The fields asked for, and nothing more.
 *
 * Places bills per field group, so this list is the invoice. `reviews` and
 * `rating` are in the Atmosphere group, which is the expensive one — asking
 * for `formatted_phone_number` beside them would cost money for something no
 * caller reads.
 */
export const PLACES_FIELDS = "name,rating,user_ratings_total,reviews,url" as const;

/** A listing is read once a day at most; ten seconds is generous for one GET. */
export const PLACES_TIMEOUT_MS = 10_000;

export interface GooglePlacesConfig {
  apiKey: string;
}

export interface PlacesHttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Places' `status` strings, mapped to an answer the caller can act on. */
function refusalFor(status: string, message: string | undefined): PlacesRefused {
  switch (status) {
    case "NOT_FOUND":
    case "ZERO_RESULTS":
    case "INVALID_REQUEST":
      return new PlacesRefused("not_found", message ?? `Google does not recognise that place id (${status}).`);
    case "REQUEST_DENIED":
      return new PlacesRefused("denied", message ?? "Google refused the request — check the key and that Places API is enabled.");
    case "OVER_QUERY_LIMIT":
      return new PlacesRefused("over_quota", message ?? "Google's daily quota for this key is used up.");
    default:
      return new PlacesRefused("unavailable", message ?? `Google answered ${status}.`);
  }
}

/**
 * One review from Places' JSON, or null.
 *
 * Null rather than throwing for a review that is missing a field: one odd
 * entry in a list of five must not cost a client their whole reviews band.
 * The shape is validated at the edge because this is other people's JSON — a
 * missing `time` would otherwise become `NaN` and render as "53 years ago".
 */
function reviewFrom(raw: unknown): GoogleReview | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const author = typeof r.author_name === "string" ? r.author_name : null;
  const rating = typeof r.rating === "number" ? Math.round(r.rating) : null;
  const time = typeof r.time === "number" ? r.time : null;
  if (author === null || rating === null || time === null) return null;
  if (rating < 1 || rating > 5) return null;

  const photo = typeof r.profile_photo_url === "string" && r.profile_photo_url.startsWith("https://")
    ? r.profile_photo_url
    : undefined;

  return {
    author,
    rating,
    text: typeof r.text === "string" ? r.text : "",
    relativeTime: typeof r.relative_time_description === "string" ? r.relative_time_description : "",
    time,
    ...(photo ? { profilePhotoUrl: photo } : {}),
  };
}

/**
 * Google Places Details, read-only.
 *
 * The key is a **server** key and must stay one: it is never sent to a browser
 * and never reaches a client's website — the whole point of the public reviews
 * endpoint is that a client's site holds no Google credential. If this key
 * ever needs an HTTP referrer restriction it is being used from the wrong
 * place.
 *
 * No caching here. The caller stores the answer in `site_reviews` and decides
 * when to ask again, which is the layer that knows the difference between "a
 * client pressed refresh" and "the nightly sweep came round".
 */
export class GooglePlacesProvider implements ReviewsProvider {
  readonly name = "google-places";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: GooglePlacesConfig,
    options: PlacesHttpOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? PLACES_TIMEOUT_MS;
  }

  async fetchPlace(placeId: string): Promise<PlaceReviews> {
    const id = PlaceId.parse(placeId);
    const url = new URL(PLACES_ENDPOINT);
    url.searchParams.set("place_id", id);
    url.searchParams.set("fields", PLACES_FIELDS);
    url.searchParams.set("key", this.config.apiKey);
    // British English relative strings, to match everything else we show.
    url.searchParams.set("language", "en-GB");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    } catch (error) {
      throw new PlacesRefused("unavailable", `Could not reach Google: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new PlacesRefused(response.status === 429 ? "over_quota" : "unavailable", `Google answered HTTP ${response.status}.`);
    }

    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new PlacesRefused("unavailable", "Google's answer was not JSON.");
    }

    const status = typeof body.status === "string" ? body.status : "UNKNOWN";
    if (status !== "OK") {
      throw refusalFor(status, typeof body.error_message === "string" ? body.error_message : undefined);
    }

    const result = (typeof body.result === "object" && body.result !== null ? body.result : {}) as Record<string, unknown>;
    const rawReviews = Array.isArray(result.reviews) ? result.reviews : [];

    return PlaceReviews.parse({
      name: typeof result.name === "string" ? result.name : "",
      rating: typeof result.rating === "number" ? result.rating : null,
      // A listing with ratings but no bodies still has a count, and that count
      // is the figure a homepage prints. Never `reviews.length`.
      count: typeof result.user_ratings_total === "number" ? result.user_ratings_total : 0,
      url: typeof result.url === "string" ? result.url : null,
      reviews: rawReviews.flatMap((raw) => {
        const review = reviewFrom(raw);
        return review ? [review] : [];
      }),
    });
  }
}
