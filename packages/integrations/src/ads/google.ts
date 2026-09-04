import type { AdAccountSummary, AdDailyMetrics, AdsAdapter } from "./types.js";

export interface GoogleAdsCredentials {
  developerToken?: string;
  customerId?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

const NOT_IMPLEMENTED =
  "GoogleAdsAdapter is an interface-only adapter: wire the Google Ads API client once real credentials exist. Use ADS_ADAPTER=mock until then.";

/**
 * Interface-complete Google Ads adapter. It refuses to construct without
 * credentials and never invents numbers — a client-facing ad report built on
 * fabricated spend would be worse than no report at all.
 */
export class GoogleAdsAdapter implements AdsAdapter {
  readonly name = "google" as const;

  constructor(private readonly credentials: GoogleAdsCredentials) {
    const missing = (["developerToken", "customerId", "clientId", "clientSecret", "refreshToken"] as const)
      .filter((key) => !credentials[key]);
    if (missing.length > 0) {
      throw new Error(`GoogleAdsAdapter credentials required: missing ${missing.join(", ")}`);
    }
  }

  async listAccounts(): Promise<AdAccountSummary[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async fetchDailyMetrics(): Promise<AdDailyMetrics> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
