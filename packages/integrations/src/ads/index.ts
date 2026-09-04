import { MockAdsAdapter } from "./mock.js";
import type { AdsAdapter } from "./types.js";

export * from "./types.js";
export { MockAdsAdapter } from "./mock.js";
export { GoogleAdsAdapter } from "./google.js";
export { MetaAdsAdapter } from "./meta.js";

/**
 * Only the mock is selectable today. `ADS_ADAPTER=google|meta` is accepted but
 * still returns the mock, because constructing a real adapter without
 * credentials throws and would take the worker down at boot. Swap this branch
 * for a credential check when Google Ads and Meta credentials are supplied.
 */
export function createAdsAdapter(env: NodeJS.ProcessEnv): AdsAdapter {
  return new MockAdsAdapter(env.MOCK_ADS_DROP_FROM !== undefined ? { dropFrom: env.MOCK_ADS_DROP_FROM } : {});
}
