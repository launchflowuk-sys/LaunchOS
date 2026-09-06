import { AdsApiError, AdsAuthError, AdsRateLimitError } from "./errors.js";
import {
  assertIsoDate, createHttpRuntime, isRecord, parseJson, sendWithRetry,
  type AdsHttpOptions, type HttpReply, type HttpRuntime,
} from "./http.js";
import { microsToMinorUnits, toNumber, unitsToMinorUnits } from "./money.js";
import type { AdAccountSummary, AdCampaignMetrics, AdDailyMetrics, AdsAdapter } from "./types.js";

/**
 * Pinned, not "latest": Google removes a version roughly a year after it ships,
 * and a floating version would change the response shape under us on their
 * schedule rather than ours. Override with `GOOGLE_ADS_API_VERSION` when the
 * sunset notice arrives, then bump this once it is verified.
 */
export const GOOGLE_ADS_API_VERSION = "v25";
const GOOGLE_ADS_ENDPOINT = "https://googleads.googleapis.com";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh a minute early so a token cannot expire mid-flight. */
const TOKEN_SKEW_SECONDS = 60;

export interface GoogleAdsCredentials {
  developerToken?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  refreshToken?: string | undefined;
  /**
   * The manager (MCC) account the developer token is approved under. Sent as
   * `login-customer-id` on every call, and the account `listAccounts()`
   * enumerates the children of.
   */
  loginCustomerId?: string | undefined;
}

export interface GoogleAdsOptions extends GoogleAdsCredentials, AdsHttpOptions {
  apiVersion?: string;
  endpoint?: string;
  tokenUrl?: string;
}

const REQUIRED = ["developerToken", "clientId", "clientSecret", "refreshToken", "loginCustomerId"] as const;

/** Accepts `123-456-7890` as well as `1234567890`; the API wants bare digits. */
function normaliseCustomerId(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) {
    throw new TypeError(`google ads: customer id has no digits: ${JSON.stringify(value)}`);
  }
  return digits;
}

interface GoogleMetrics {
  costMicros?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  conversions?: unknown;
  conversionsValue?: unknown;
}

/** One campaign's day, summed before anything is rounded. */
interface CampaignTotals {
  name: string;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  currency: string;
}

interface GoogleRow {
  customer?: { currencyCode?: unknown } | undefined;
  campaign?: { id?: unknown; name?: unknown } | undefined;
  customerClient?: { id?: unknown; descriptiveName?: unknown; currencyCode?: unknown; manager?: unknown } | undefined;
  metrics?: GoogleMetrics | undefined;
  segments?: { date?: unknown } | undefined;
}

/**
 * `searchStream` answers with a JSON *array* of chunks, each carrying its own
 * `results` — not one object with every row. A client that reads
 * `body.results` gets `undefined` and reports a zero-spend day.
 */
function parseStreamRows(reply: HttpReply): GoogleRow[] {
  const parsed = parseJson(reply.text);
  if (parsed === undefined) {
    throw new AdsApiError("google", reply.status, reply.text, "searchStream returned a body that is not JSON");
  }
  const chunks = Array.isArray(parsed) ? parsed : [parsed];
  const rows: GoogleRow[] = [];
  for (const chunk of chunks) {
    if (!isRecord(chunk)) continue;
    const results = chunk.results;
    if (Array.isArray(results)) rows.push(...(results as GoogleRow[]));
  }
  return rows;
}

/** Google reports one failure as `{error:{…}}` and a stream failure as `[{error:{…}}]`. */
function googleErrorMessage(text: string): { message: string; status: string } {
  const parsed = parseJson(text);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = isRecord(first) && isRecord(first.error) ? first.error : undefined;
  return {
    message: typeof error?.message === "string" ? error.message : text,
    status: typeof error?.status === "string" ? error.status : "",
  };
}

function googleFailure(reply: HttpReply): AdsApiError {
  const { message, status } = googleErrorMessage(reply.text);
  // 403 is Google's answer to an unapproved or wrong developer token and to a
  // login-customer-id that does not manage the account — both need a human.
  if (reply.status === 401 || reply.status === 403) {
    return new AdsAuthError("google", reply.status, reply.text, message);
  }
  if (reply.status === 429 || status === "RESOURCE_EXHAUSTED") {
    return new AdsRateLimitError("google", reply.status, reply.text, message);
  }
  return new AdsApiError("google", reply.status, reply.text, message);
}

function isGoogleRetryable(reply: HttpReply): boolean {
  if (reply.status === 429 || reply.status >= 500) return true;
  return googleErrorMessage(reply.text).status === "RESOURCE_EXHAUSTED";
}

const DAILY_METRICS_FIELDS = [
  "customer.currency_code",
  "segments.date",
  "metrics.cost_micros",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.conversions",
  "metrics.conversions_value",
].join(", ");

const CAMPAIGN_METRICS_FIELDS = [
  "campaign.id",
  "campaign.name",
  "customer.currency_code",
  "segments.date",
  "metrics.cost_micros",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.conversions",
  "metrics.conversions_value",
].join(", ");

const ACCOUNT_FIELDS = [
  "customer_client.id",
  "customer_client.descriptive_name",
  "customer_client.currency_code",
  "customer_client.manager",
].join(", ");

/**
 * Google Ads via the REST API.
 *
 * Account-level daily figures come from `FROM customer` rather than
 * `FROM campaign`, so a day is one row and nothing has to be de-duplicated
 * across campaigns that share a conversion. A day with no delivery returns no
 * rows at all, which is a real zero and is reported as one.
 */
export class GoogleAdsAdapter implements AdsAdapter {
  readonly name = "google" as const;

  private readonly developerToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly loginCustomerId: string;
  private readonly apiVersion: string;
  private readonly endpoint: string;
  private readonly tokenUrl: string;
  private readonly http: HttpRuntime;

  private token: { value: string; expiresAtMs: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(options: GoogleAdsOptions) {
    const missing = REQUIRED.filter((key) => !options[key]);
    if (missing.length > 0) {
      throw new Error(`GoogleAdsAdapter credentials required: missing ${missing.join(", ")}`);
    }
    this.developerToken = options.developerToken as string;
    this.clientId = options.clientId as string;
    this.clientSecret = options.clientSecret as string;
    this.refreshToken = options.refreshToken as string;
    this.loginCustomerId = normaliseCustomerId(options.loginCustomerId as string);
    this.apiVersion = options.apiVersion ?? GOOGLE_ADS_API_VERSION;
    this.endpoint = (options.endpoint ?? GOOGLE_ADS_ENDPOINT).replace(/\/+$/, "");
    this.tokenUrl = options.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL;
    this.http = createHttpRuntime(options);
  }

  async listAccounts(): Promise<AdAccountSummary[]> {
    const rows = await this.searchStream(
      this.loginCustomerId,
      `SELECT ${ACCOUNT_FIELDS} FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = FALSE`,
    );
    const accounts: AdAccountSummary[] = [];
    for (const row of rows) {
      const client = row.customerClient;
      const id = client?.id === undefined || client.id === null ? "" : String(client.id);
      if (id === "") continue;
      const name = typeof client?.descriptiveName === "string" && client.descriptiveName !== ""
        ? client.descriptiveName
        : id;
      accounts.push({
        externalId: id,
        platform: "google",
        name,
        currency: typeof client?.currencyCode === "string" ? client.currencyCode.toUpperCase() : "",
      });
    }
    return accounts;
  }

  async fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics> {
    const day = assertIsoDate(date);
    const rows = await this.searchStream(
      normaliseCustomerId(accountId),
      `SELECT ${DAILY_METRICS_FIELDS} FROM customer WHERE segments.date BETWEEN '${day}' AND '${day}'`,
    );

    // Micros and the raw conversion float are summed *before* rounding: a
    // single date is one row today, but rounding each row first would drift if
    // the answer is ever segmented further.
    let costMicros = 0;
    let impressions = 0;
    let clicks = 0;
    let conversions = 0;
    let conversionValue = 0;
    let currency = "";
    for (const row of rows) {
      const metrics = row.metrics ?? {};
      costMicros += toNumber(metrics.costMicros);
      impressions += toNumber(metrics.impressions);
      clicks += toNumber(metrics.clicks);
      conversions += toNumber(metrics.conversions);
      conversionValue += toNumber(metrics.conversionsValue);
      const code = row.customer?.currencyCode;
      if (currency === "" && typeof code === "string") currency = code.toUpperCase();
    }

    const spendPence = microsToMinorUnits(costMicros);
    const conversionValuePence = unitsToMinorUnits(conversionValue);
    return {
      date: day,
      spendPence,
      impressions: Math.round(impressions),
      clicks: Math.round(clicks),
      // `metrics.conversions` is a float — fractional attribution gives 3.5.
      // The snapshot column is an integer.
      conversions: Math.round(conversions),
      conversionValuePence,
      cpcPence: clicks === 0 ? 0 : spendPence / clicks,
      roas: spendPence === 0 ? 0 : conversionValuePence / spendPence,
      ...(currency === "" ? {} : { currency }),
    };
  }

  /**
   * The same day, `FROM campaign`. One row per campaign that delivered;
   * a campaign that spent nothing returns no row and is correctly absent
   * rather than reported as a zero-spend campaign.
   *
   * Rows are folded by campaign id rather than trusted to be unique: a query
   * segmented further in future would return several rows per campaign, and
   * summing is right in both cases.
   */
  async fetchCampaignMetrics(accountId: string, date: string): Promise<AdCampaignMetrics[]> {
    const day = assertIsoDate(date);
    const rows = await this.searchStream(
      normaliseCustomerId(accountId),
      `SELECT ${CAMPAIGN_METRICS_FIELDS} FROM campaign WHERE segments.date BETWEEN '${day}' AND '${day}'`,
    );

    const byCampaign = new Map<string, CampaignTotals>();
    for (const row of rows) {
      const id = row.campaign?.id === undefined || row.campaign.id === null ? "" : String(row.campaign.id);
      if (id === "") continue;
      const metrics = row.metrics ?? {};
      const code = row.customer?.currencyCode;
      const existing = byCampaign.get(id) ?? {
        name: typeof row.campaign?.name === "string" && row.campaign.name !== "" ? row.campaign.name : id,
        costMicros: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0,
        currency: typeof code === "string" ? code.toUpperCase() : "",
      };
      byCampaign.set(id, {
        ...existing,
        costMicros: existing.costMicros + toNumber(metrics.costMicros),
        impressions: existing.impressions + toNumber(metrics.impressions),
        clicks: existing.clicks + toNumber(metrics.clicks),
        conversions: existing.conversions + toNumber(metrics.conversions),
        conversionValue: existing.conversionValue + toNumber(metrics.conversionsValue),
      });
    }

    return [...byCampaign].map(([campaignExternalId, totals]) => ({
      date: day,
      campaignExternalId,
      campaignName: totals.name,
      spendPence: microsToMinorUnits(totals.costMicros),
      impressions: Math.round(totals.impressions),
      clicks: Math.round(totals.clicks),
      conversions: Math.round(totals.conversions),
      conversionValuePence: unitsToMinorUnits(totals.conversionValue),
      ...(totals.currency === "" ? {} : { currency: totals.currency }),
    }));
  }

  private async searchStream(customerId: string, query: string): Promise<GoogleRow[]> {
    const accessToken = await this.accessToken();
    const reply = await sendWithRetry(this.http, {
      url: `${this.endpoint}/${this.apiVersion}/customers/${customerId}/googleAds:searchStream`,
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "developer-token": this.developerToken,
          "login-customer-id": this.loginCustomerId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    }, isGoogleRetryable);
    if (!reply.ok) {
      // A 401 here is nearly always a token this instance cached before the
      // grant changed; drop it so the next call re-refreshes rather than
      // replaying the dead one for the life of the worker.
      if (reply.status === 401) this.token = null;
      throw googleFailure(reply);
    }
    return parseStreamRows(reply);
  }

  /**
   * Cached until just before expiry, and single-flighted so a batch of accounts
   * does not open one refresh per account.
   */
  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;
    this.refreshing ??= this.requestAccessToken().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async requestAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });
    const reply = await sendWithRetry(this.http, {
      url: this.tokenUrl,
      init: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    }, (r) => r.status === 429 || r.status >= 500);

    const parsed = parseJson(reply.text);
    const payload = isRecord(parsed) ? parsed : {};
    if (!reply.ok) {
      const description = typeof payload.error_description === "string" ? payload.error_description : undefined;
      const code = typeof payload.error === "string" ? payload.error : undefined;
      const summary = [code, description].filter((part) => part !== undefined).join(": ");
      // Everything below 500 from the token endpoint is a credential problem —
      // invalid_grant (revoked or expired refresh token), invalid_client (wrong
      // secret), unauthorized_client. None of them get better on a retry.
      const detail = summary === "" ? undefined : summary;
      if (reply.status < 500) throw new AdsAuthError("google", reply.status, reply.text, detail);
      throw new AdsApiError("google", reply.status, reply.text, detail);
    }

    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (accessToken === "") {
      throw new AdsAuthError("google", reply.status, reply.text, "token endpoint returned no access_token");
    }
    const expiresIn = toNumber(payload.expires_in) || 3600;
    // Floored at zero, not at the skew: a token that lives less than the skew
    // is cached for no time at all and re-fetched, rather than being kept for
    // longer than it is valid.
    this.token = {
      value: accessToken,
      expiresAtMs: Date.now() + Math.max(0, expiresIn - TOKEN_SKEW_SECONDS) * 1000,
    };
    return accessToken;
  }
}
