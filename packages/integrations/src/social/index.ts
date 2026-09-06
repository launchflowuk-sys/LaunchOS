import { GbpPublisher, type GbpOptions } from "./gbp.js";
import { MetaSocialPublisher, type MetaSocialOptions } from "./meta.js";
import { MockSocialPublisher } from "./mock.js";
import type { SocialPublishInput, SocialPublishResult, SocialPublisher, SocialPublisherName } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export { MockSocialPublisher } from "./mock.js";
export {
  META_GRAPH_API_VERSION as META_SOCIAL_GRAPH_API_VERSION, MetaSocialPublisher,
  type MetaSocialCredentials, type MetaSocialOptions, type SocialHttpOptions,
} from "./meta.js";
export {
  GBP_API_ENDPOINT, GBP_ACCOUNTS_ENDPOINT, GBP_LOCATIONS_ENDPOINT, GBP_OAUTH_SCOPE, GBP_SUMMARY_MAX_CHARS, GBP_LANGUAGE_CODE,
  GbpPublisher, type GbpCredentials, type GbpOptions, type GbpLocation,
} from "./gbp.js";
export { GoogleOAuthTokenSource, GOOGLE_OAUTH_TOKEN_URL, type GoogleOAuthCredentials } from "./gbp-oauth.js";
export { lookupInstagramForPage, type InstagramAccount, type InstagramLookupOptions } from "./instagram-lookup.js";

/**
 * The same two variables the Meta *ads* adapter reads. One system-user token
 * carries both jobs — insights for the Ad Performance Sentinel and publishing
 * for the content engine — as long as it was generated with the publishing
 * permissions listed on `MetaSocialPublisher`. There is deliberately no
 * separate `META_SOCIAL_*` pair: two tokens for one app is two things to lose
 * in a redeploy.
 */
export const META_SOCIAL_ENV_KEYS = ["META_ADS_ACCESS_TOKEN", "META_ADS_APP_SECRET"] as const;

/**
 * Google Business Profile has its own OAuth client and refresh token rather
 * than sharing `GOOGLE_ADS_*`: the Ads refresh token was minted for the
 * `adwords` scope only, and re-minting it with `business.manage` added would
 * mean touching a live ads credential to turn on posting. Separate keys, same
 * Cloud project if you like.
 */
export const GBP_ENV_KEYS = ["GBP_CLIENT_ID", "GBP_CLIENT_SECRET", "GBP_REFRESH_TOKEN"] as const;

function allSet(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.every((key) => (env[key] ?? "").trim() !== "");
}

/** Whether a real Meta publisher can be built from this environment. Blank counts as unset, as everywhere else. */
export function hasMetaSocialCredentials(env: NodeJS.ProcessEnv): boolean {
  return allSet(env, META_SOCIAL_ENV_KEYS);
}

/** Whether a real Business Profile publisher can be built from this environment. */
export function hasGbpCredentials(env: NodeJS.ProcessEnv): boolean {
  return allSet(env, GBP_ENV_KEYS);
}

/** What a caller may inject beyond the environment — `fetch` and `sleep` in tests, nothing in production. */
export type SocialPublisherDeps =
  Pick<MetaSocialOptions, "fetch" | "sleep" | "timeoutMs" | "pollAttempts" | "pollIntervalMs">
  & Pick<GbpOptions, "endpoint" | "accountsEndpoint" | "locationsEndpoint" | "tokenUrl">;

export interface SocialPublisherHalves {
  /** Facebook and Instagram. */
  readonly meta: SocialPublisher;
  /** Google Business Profile. */
  readonly gbp: SocialPublisher;
}

/**
 * One publisher per provider, chosen by the input's channel. Each half is real
 * only when its own keys are set and the mock otherwise, so a deployment with
 * Meta live and GBP still waiting on Google's approval posts to Facebook for
 * real and to a mock for GBP — and the guard says so at startup.
 */
export class CompositeSocialPublisher implements SocialPublisher {
  readonly name: SocialPublisherName;

  constructor(private readonly halves: SocialPublisherHalves) {
    const real = [halves.meta.name === "meta" ? "meta" : null, halves.gbp.name === "gbp" ? "gbp" : null]
      .filter((n): n is "meta" | "gbp" => n !== null);
    this.name = real.length === 0 ? "mock-social" : (real.join("+") as SocialPublisherName);
  }

  /** The half a channel goes to, for a caller that needs the provider itself (the mock's `calls`, `listLocations`). */
  for(channel: SocialPublishInput["channel"]): SocialPublisher {
    return channel === "gbp" ? this.halves.gbp : this.halves.meta;
  }

  publish(input: SocialPublishInput): Promise<SocialPublishResult> {
    return this.for(input.channel).publish(input);
  }
}

/**
 * Nothing set → the plain mock. Otherwise a composite routing facebook and
 * instagram to Meta and gbp to Google, each real only when its own keys are
 * all present. Mirrored by `resolveSocial` in `adapter-guard.ts`, which is
 * what makes a production process running on a mock visible.
 */
export function createSocialPublisherFromEnv(env: NodeJS.ProcessEnv, deps: SocialPublisherDeps = {}): SocialPublisher {
  const metaLive = hasMetaSocialCredentials(env);
  const gbpLive = hasGbpCredentials(env);
  if (!metaLive && !gbpLive) return new MockSocialPublisher();
  const { endpoint, accountsEndpoint, locationsEndpoint, tokenUrl, ...shared } = deps;
  const meta: SocialPublisher = metaLive
    ? new MetaSocialPublisher({
      accessToken: env.META_ADS_ACCESS_TOKEN,
      appSecret: env.META_ADS_APP_SECRET,
      ...(env.META_ADS_API_VERSION?.trim() ? { apiVersion: env.META_ADS_API_VERSION.trim() } : {}),
      ...shared,
    })
    : new MockSocialPublisher();
  const gbp: SocialPublisher = gbpLive
    ? new GbpPublisher({
      clientId: env.GBP_CLIENT_ID,
      clientSecret: env.GBP_CLIENT_SECRET,
      refreshToken: env.GBP_REFRESH_TOKEN,
      ...(shared.fetch ? { fetch: shared.fetch } : {}),
      ...(shared.sleep ? { sleep: shared.sleep } : {}),
      ...(shared.timeoutMs !== undefined ? { timeoutMs: shared.timeoutMs } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(accountsEndpoint ? { accountsEndpoint } : {}),
      ...(locationsEndpoint ? { locationsEndpoint } : {}),
      ...(tokenUrl ? { tokenUrl } : {}),
    })
    : new MockSocialPublisher();
  return new CompositeSocialPublisher({ meta, gbp });
}
