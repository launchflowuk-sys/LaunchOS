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
  /**
   * The same day broken down by campaign, for the cost-per-lead join.
   *
   * Optional on the interface because an adapter is free not to have it — an
   * account whose provider cannot answer keeps its account-level snapshot and
   * simply contributes no campaign rows, which the cost-per-lead screen
   * reports as unplaced spend rather than as zero. Every adapter in this
   * package implements it.
   */
  fetchCampaignMetrics?(accountId: string, date: string, platform?: AdPlatform): Promise<AdCampaignMetrics[]>;
}

/**
 * One campaign's share of one day.
 *
 * A separate shape from `AdDailyMetrics` rather than an extension of it: there
 * is no `cpcPence` or `roas` here because those are derived, and deriving them
 * per campaign per day and then averaging them across a period is the classic
 * way to publish a wrong number. The core layer sums the raw figures over the
 * period and divides once.
 */
export interface AdCampaignMetrics {
  date: string;
  /** The provider's own campaign id. Stable when the campaign is renamed. */
  campaignExternalId: string;
  /** The campaign's name as it stands today — what a `utm_campaign` is matched against. */
  campaignName: string;
  spendPence: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValuePence: number;
  currency?: string;
}
