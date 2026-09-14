import { GooglePlacesProvider, type PlacesHttpOptions } from "./google-places.js";
import { MockReviewsProvider } from "./mock.js";
import type { ReviewsProvider } from "./types.js";

export * from "./types.js";
export { MockReviewsProvider } from "./mock.js";
export {
  GooglePlacesProvider,
  PLACES_ENDPOINT,
  PLACES_FIELDS,
  PLACES_TIMEOUT_MS,
  type GooglePlacesConfig,
  type PlacesHttpOptions,
} from "./google-places.js";

/** The key that selects the real provider. Places API must be enabled on it. */
export const REVIEWS_ENV_KEY = "GOOGLE_MAPS_API_KEY";

function trimmedOrUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Selection is **by key alone**, unlike screenshots and image generation.
 *
 * Those two need `SCREENSHOT_ADAPTER=` / `IMAGEGEN_ADAPTER=` said out loud
 * because each call costs money and a key arriving for another purpose must
 * not quietly start spending. A Places Details call is a fraction of a penny
 * and happens once a day per site, and — the deciding difference — nothing is
 * fetched for a site until somebody has typed a place id into it and switched
 * `reviews_enabled` on. That switch *is* the deliberate act, so asking for a
 * second one in the environment would only produce a deployment where a client
 * has enabled reviews and no reviews arrive.
 */
export function createReviewsProviderFromEnv(env: NodeJS.ProcessEnv, options: PlacesHttpOptions = {}): ReviewsProvider {
  const apiKey = trimmedOrUnset(env[REVIEWS_ENV_KEY]);
  if (apiKey) return new GooglePlacesProvider({ apiKey }, options);
  return new MockReviewsProvider();
}
