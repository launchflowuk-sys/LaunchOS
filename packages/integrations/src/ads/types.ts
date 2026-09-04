export type AdPlatform = "google" | "meta";

export interface AdAccountSummary {
  externalId: string;
  platform: AdPlatform;
  name: string;
  currency: string;
}

export interface AdDailyMetrics {
  date: string;
  spendPence: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValuePence: number;
  cpcPence: number;
  roas: number;
}

export interface AdsAdapter {
  readonly name: "mock" | "google" | "meta";
  listAccounts(): Promise<AdAccountSummary[]>;
  /** `date` is an ISO calendar date, `YYYY-MM-DD`. */
  fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics>;
}
