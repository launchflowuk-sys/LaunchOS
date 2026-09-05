import { AdsRoutingError } from "./errors.js";
import type { AdAccountSummary, AdDailyMetrics, AdPlatform, AdsAdapter } from "./types.js";

/**
 * Which platform an external id belongs to, when the caller did not say.
 *
 * `ad_accounts.platform` is the real answer and callers should pass it — this
 * is the fallback for the one caller that cannot yet (`ingestDailyMetrics`
 * hands the adapter an `externalId` and a date and nothing else). Guessing is
 * safe *here* in a way it is not elsewhere in this codebase: a Google customer
 * id sent to Graph comes back as a 400, not as a plausible-looking row, so a
 * wrong guess fails loudly instead of writing a wrong number into a client
 * report.
 *
 * The rule is the id shape. A Google customer id is exactly ten digits; a Meta
 * ad account id is longer (fifteen or sixteen) and is often written `act_…`.
 */
export function inferPlatform(externalId: string): AdPlatform {
  if (/^act_/i.test(externalId.trim())) return "meta";
  return externalId.replace(/\D/g, "").length === 10 ? "google" : "meta";
}

export interface PlatformAdsAdapters {
  readonly google: AdsAdapter;
  readonly meta: AdsAdapter;
}

/**
 * One `AdsAdapter` over both providers, for the deployment that manages Google
 * *and* Meta spend.
 *
 * Only built when both sets of credentials are present —
 * `createAdsAdapterFromEnv` returns the single real adapter when only one is
 * configured, so this class never stands between an account and the only
 * provider that could serve it.
 */
export class MultiPlatformAdsAdapter implements AdsAdapter {
  readonly name = "multi" as const;

  constructor(private readonly adapters: PlatformAdsAdapters) {}

  /** Both providers, in one list. A failure on either is a failure here: a
   * half-answer would read as "that account is gone" to whoever is picking
   * accounts to connect. */
  async listAccounts(): Promise<AdAccountSummary[]> {
    const [google, meta] = await Promise.all([
      this.adapters.google.listAccounts(),
      this.adapters.meta.listAccounts(),
    ]);
    return [...google, ...meta];
  }

  async fetchDailyMetrics(accountId: string, date: string, platform?: AdPlatform): Promise<AdDailyMetrics> {
    const resolved = platform ?? inferPlatform(accountId);
    const adapter = this.adapters[resolved];
    if (adapter === undefined) {
      throw new AdsRoutingError(`ads: no adapter configured for platform ${JSON.stringify(resolved)}`);
    }
    return adapter.fetchDailyMetrics(accountId, date, resolved);
  }
}
