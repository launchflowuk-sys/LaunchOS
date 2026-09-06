import type { AdAccountSummary, AdCampaignMetrics, AdDailyMetrics, AdsAdapter } from "./types.js";

export interface MockAdsOptions {
  accounts?: AdAccountSummary[];
  /**
   * The campaign names the mock splits a day's spend across. They are the
   * names a `utm_campaign` is matched against, so the dev seed's funnel links
   * carry the same strings and the cost-per-lead screen has something real to
   * join locally.
   */
  campaigns?: readonly string[];
  /** ISO date from which conversions are scaled down, to simulate a ROAS slide. */
  dropFrom?: string;
  dropFactor?: number;
}

/**
 * What a LaunchFlow client's ads are usually called. Three, so a single
 * account has more than one campaign and the join has to actually work.
 */
export const DEFAULT_MOCK_CAMPAIGNS: readonly string[] = ["spring-offer", "brand-search", "local-services"];

/** FNV-1a, 32 bit. Stable across runs and platforms — no Math.random anywhere. */
function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A stable pseudo-random number in [0, 1) for a seed string. */
function unit(seed: string): number {
  return hash32(seed) / 0x1_0000_0000;
}

export class MockAdsAdapter implements AdsAdapter {
  readonly name = "mock" as const;

  private readonly accounts: AdAccountSummary[];
  private readonly campaigns: readonly string[];
  private readonly dropFrom: string | undefined;
  private readonly dropFactor: number;

  constructor(options: MockAdsOptions = {}) {
    this.accounts = options.accounts ?? [];
    this.campaigns = options.campaigns ?? DEFAULT_MOCK_CAMPAIGNS;
    this.dropFrom = options.dropFrom;
    this.dropFactor = options.dropFactor ?? 0.45;
  }

  async listAccounts(): Promise<AdAccountSummary[]> {
    return this.accounts;
  }

  async fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics> {
    const seed = (suffix: string) => unit(`${accountId}:${date}:${suffix}`);
    const impressions = 4000 + Math.round(seed("impressions") * 4000);
    const droppedIn = this.dropFrom !== undefined && date >= this.dropFrom;
    const rawClicks = Math.max(1, Math.round(impressions * (0.03 + seed("ctr") * 0.02)));
    // The daily budget is set from the undropped click count, so spend stays
    // roughly flat across the drop date. Clicks are then reduced — the same
    // budget now buys fewer of them, which is what actually pushes CPC
    // (spend / clicks) up rather than leaving it untouched.
    const spendPence = Math.round(rawClicks * (70 + seed("cpc") * 60));
    const clicks = droppedIn ? Math.max(1, Math.round(rawClicks * 0.7)) : rawClicks;
    const factor = droppedIn ? this.dropFactor : 1;
    const conversions = Math.round(clicks * (0.06 + seed("cvr") * 0.04) * factor);
    const conversionValuePence = Math.round(conversions * (4500 + seed("aov") * 2000));
    return {
      date,
      spendPence,
      impressions,
      clicks,
      conversions,
      conversionValuePence,
      cpcPence: spendPence / clicks,
      roas: spendPence === 0 ? 0 : conversionValuePence / spendPence,
    };
  }

  /**
   * The day's account figures cut across the configured campaigns, by a stable
   * per-campaign weight. The parts are made to sum to the account total
   * exactly — the last campaign takes the remainder — because the whole point
   * of the cost-per-lead screen is to say how much of an account's spend it
   * could place, and a mock that quietly loses three pence a day to rounding
   * would make that number lie in development.
   */
  async fetchCampaignMetrics(accountId: string, date: string): Promise<AdCampaignMetrics[]> {
    if (this.campaigns.length === 0) return [];
    const day = await this.fetchDailyMetrics(accountId, date);
    const weights = this.campaigns.map((name) => 0.2 + unit(`${accountId}:${date}:${name}`) * 0.8);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const split = (whole: number, index: number, running: number): number =>
      index === this.campaigns.length - 1 ? whole - running : Math.round((whole * weights[index]!) / total);

    const rows: AdCampaignMetrics[] = [];
    let spent = 0;
    let shown = 0;
    let clicked = 0;
    let converted = 0;
    let valued = 0;
    for (const [index, name] of this.campaigns.entries()) {
      const spendPence = split(day.spendPence, index, spent);
      const impressions = split(day.impressions, index, shown);
      const clicks = split(day.clicks, index, clicked);
      const conversions = split(day.conversions, index, converted);
      const conversionValuePence = split(day.conversionValuePence, index, valued);
      spent += spendPence;
      shown += impressions;
      clicked += clicks;
      converted += conversions;
      valued += conversionValuePence;
      rows.push({
        date, campaignExternalId: `${hash32(`${accountId}:${name}`)}`, campaignName: name,
        spendPence, impressions, clicks, conversions, conversionValuePence,
      });
    }
    return rows;
  }
}
