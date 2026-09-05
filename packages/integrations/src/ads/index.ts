import { GoogleAdsAdapter } from "./google.js";
import { MetaAdsAdapter } from "./meta.js";
import { MockAdsAdapter } from "./mock.js";
import { MultiPlatformAdsAdapter } from "./routing.js";
import type { AdsAdapter } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export { MockAdsAdapter } from "./mock.js";
export { GOOGLE_ADS_API_VERSION, GoogleAdsAdapter, type GoogleAdsCredentials, type GoogleAdsOptions } from "./google.js";
export {
  DEFAULT_META_CONVERSION_ACTIONS, META_GRAPH_API_VERSION, MetaAdsAdapter,
  type MetaAdsCredentials, type MetaAdsOptions,
} from "./meta.js";
export { MultiPlatformAdsAdapter, inferPlatform, type PlatformAdsAdapters } from "./routing.js";
export type { AdsHttpOptions, FetchLike } from "./http.js";

/**
 * Only the mock is selectable through this factory. `ADS_ADAPTER=google|meta` is
 * accepted but still returns the mock.
 *
 * Kept as it was on purpose: `createIntegrations` and `adapter-guard` both
 * describe *this* function's behaviour, and switching it is a wiring change
 * with its own env docs and production-guard rules. Use
 * `createAdsAdapterFromEnv` for the credential-driven selection.
 */
export function createAdsAdapter(env: NodeJS.ProcessEnv): AdsAdapter {
  return new MockAdsAdapter(env.MOCK_ADS_DROP_FROM !== undefined ? { dropFrom: env.MOCK_ADS_DROP_FROM } : {});
}

/** Every Google Ads variable a real adapter needs, and nothing optional. */
const GOOGLE_ADS_ENV_KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
] as const;

const META_ADS_ENV_KEYS = ["META_ADS_ACCESS_TOKEN", "META_ADS_APP_SECRET"] as const;

function allSet(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.every((key) => (env[key] ?? "").trim() !== "");
}

/**
 * Whether a real Google Ads adapter can be built from this environment.
 *
 * Exported so `adapter-guard` can say *why* the ads adapter resolved to the
 * mock without duplicating the key list.
 */
export function hasGoogleAdsCredentials(env: NodeJS.ProcessEnv): boolean {
  return allSet(env, GOOGLE_ADS_ENV_KEYS);
}

/** Whether a real Meta Ads adapter can be built from this environment. */
export function hasMetaAdsCredentials(env: NodeJS.ProcessEnv): boolean {
  return allSet(env, META_ADS_ENV_KEYS);
}

/** The variables that would have to be set to make each platform real. */
export const ADS_ENV_KEYS = { google: GOOGLE_ADS_ENV_KEYS, meta: META_ADS_ENV_KEYS } as const;

function googleFromEnv(env: NodeJS.ProcessEnv): GoogleAdsAdapter | undefined {
  if (!hasGoogleAdsCredentials(env)) return undefined;
  return new GoogleAdsAdapter({
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    ...(env.GOOGLE_ADS_API_VERSION ? { apiVersion: env.GOOGLE_ADS_API_VERSION } : {}),
  });
}

function metaFromEnv(env: NodeJS.ProcessEnv): MetaAdsAdapter | undefined {
  if (!hasMetaAdsCredentials(env)) return undefined;
  const actions = (env.META_ADS_CONVERSION_ACTIONS ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter((type) => type !== "");
  return new MetaAdsAdapter({
    accessToken: env.META_ADS_ACCESS_TOKEN,
    appSecret: env.META_ADS_APP_SECRET,
    ...(env.META_ADS_API_VERSION ? { apiVersion: env.META_ADS_API_VERSION } : {}),
    ...(actions.length > 0 ? { conversionActionTypes: actions } : {}),
  });
}

/**
 * Builds the ads adapter each platform's credentials allow.
 *
 * Selection is by credential, not by an `ADS_ADAPTER` name, because the two
 * platforms are independent: an agency can run Google spend for one client and
 * Meta spend for another, and a single name could only ever describe one of
 * them. Which provider a given account is read from stays where it already is —
 * `ad_accounts.platform` — and reaches the adapter as the third argument to
 * `fetchDailyMetrics`.
 *
 * A half-set platform (three of the five Google variables) is treated as
 * unset and falls back to the mock rather than throwing at boot, matching
 * `createPaymentsAdapter`. `adapter-guard` is what makes that visible and
 * refuses it in production.
 */
export function createAdsAdapterFromEnv(env: NodeJS.ProcessEnv): AdsAdapter {
  const google = googleFromEnv(env);
  const meta = metaFromEnv(env);
  if (google !== undefined && meta !== undefined) return new MultiPlatformAdsAdapter({ google, meta });
  return google ?? meta ?? new MockAdsAdapter(
    env.MOCK_ADS_DROP_FROM !== undefined ? { dropFrom: env.MOCK_ADS_DROP_FROM } : {},
  );
}
