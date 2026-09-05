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
  /**
   * ISO-4217 code the provider reported the figures in, when it says.
   *
   * Optional because `ad_metric_snapshots` has no currency column — the
   * currency lives on `ad_accounts` — but the real adapters get it back on
   * every insights row, and dropping it silently would hide the one mismatch
   * that matters: an account row saying GBP over a provider reporting USD.
   */
  currency?: string;
}

export interface AdsAdapter {
  readonly name: "mock" | "google" | "meta" | "multi";
  listAccounts(): Promise<AdAccountSummary[]>;
  /**
   * `date` is an ISO calendar date, `YYYY-MM-DD`.
   *
   * `platform` is optional and only read by the multi-platform adapter, which
   * needs it to pick between a Google and a Meta client. Pass
   * `ad_accounts.platform`; every single-platform adapter ignores it.
   */
  fetchDailyMetrics(accountId: string, date: string, platform?: AdPlatform): Promise<AdDailyMetrics>;
}
