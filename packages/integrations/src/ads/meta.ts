import type { AdAccountSummary, AdDailyMetrics, AdsAdapter } from "./types.js";

export interface MetaAdsCredentials {
  accessToken?: string;
  adAccountId?: string;
  appSecret?: string;
}

const NOT_IMPLEMENTED =
  "MetaAdsAdapter is an interface-only adapter: wire the Meta Marketing API client once real credentials exist. Use ADS_ADAPTER=mock until then.";

/**
 * Interface-complete Meta Ads adapter. It refuses to construct without
 * credentials and never invents numbers — a client-facing ad report built on
 * fabricated spend would be worse than no report at all.
 */
export class MetaAdsAdapter implements AdsAdapter {
  readonly name = "meta" as const;

  constructor(private readonly credentials: MetaAdsCredentials) {
    const missing = (["accessToken", "adAccountId", "appSecret"] as const)
      .filter((key) => !credentials[key]);
    if (missing.length > 0) {
      throw new Error(`MetaAdsAdapter credentials required: missing ${missing.join(", ")}`);
    }
  }

  async listAccounts(): Promise<AdAccountSummary[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async fetchDailyMetrics(): Promise<AdDailyMetrics> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
