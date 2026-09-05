import { MetaSocialPublisher, type MetaSocialOptions } from "./meta.js";
import { MockSocialPublisher } from "./mock.js";
import type { SocialPublisher } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export { MockSocialPublisher } from "./mock.js";
export {
  META_GRAPH_API_VERSION as META_SOCIAL_GRAPH_API_VERSION, MetaSocialPublisher,
  type MetaSocialCredentials, type MetaSocialOptions, type SocialHttpOptions,
} from "./meta.js";

/**
 * The same two variables the Meta *ads* adapter reads. One system-user token
 * carries both jobs — insights for the Ad Performance Sentinel and publishing
 * for the content engine — as long as it was generated with the publishing
 * permissions listed on `MetaSocialPublisher`. There is deliberately no
 * separate `META_SOCIAL_*` pair: two tokens for one app is two things to lose
 * in a redeploy.
 */
export const META_SOCIAL_ENV_KEYS = ["META_ADS_ACCESS_TOKEN", "META_ADS_APP_SECRET"] as const;

/** Whether a real publisher can be built from this environment. Blank counts as unset, as everywhere else. */
export function hasMetaSocialCredentials(env: NodeJS.ProcessEnv): boolean {
  return META_SOCIAL_ENV_KEYS.every((key) => (env[key] ?? "").trim() !== "");
}

/** What a caller may inject beyond the environment — `fetch` and `sleep` in tests, nothing in production. */
export type SocialPublisherDeps = Pick<MetaSocialOptions, "fetch" | "sleep" | "timeoutMs" | "pollAttempts" | "pollIntervalMs">;

/**
 * The real publisher when both Meta keys are set, the mock otherwise. Mirrored
 * by `resolveSocial` in `adapter-guard.ts`, which is what makes a production
 * process running on the mock visible.
 */
export function createSocialPublisherFromEnv(env: NodeJS.ProcessEnv, deps: SocialPublisherDeps = {}): SocialPublisher {
  if (!hasMetaSocialCredentials(env)) return new MockSocialPublisher();
  return new MetaSocialPublisher({
    accessToken: env.META_ADS_ACCESS_TOKEN,
    appSecret: env.META_ADS_APP_SECRET,
    ...(env.META_ADS_API_VERSION?.trim() ? { apiVersion: env.META_ADS_API_VERSION.trim() } : {}),
    ...deps,
  });
}
