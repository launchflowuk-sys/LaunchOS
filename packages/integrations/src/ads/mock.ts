import type { AdAccountSummary, AdDailyMetrics, AdsAdapter } from "./types.js";

export interface MockAdsOptions {
  accounts?: AdAccountSummary[];
  /** ISO date from which conversions are scaled down, to simulate a ROAS slide. */
  dropFrom?: string;
  dropFactor?: number;
}

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
  private readonly dropFrom: string | undefined;
  private readonly dropFactor: number;

  constructor(options: MockAdsOptions = {}) {
    this.accounts = options.accounts ?? [];
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
}
