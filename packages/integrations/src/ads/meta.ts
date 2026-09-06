import { createHmac } from "node:crypto";
import { AdsApiError, AdsAuthError, AdsRateLimitError } from "./errors.js";
import {
  assertIsoDate, createHttpRuntime, isRecord, parseJson, sendWithRetry,
  type AdsHttpOptions, type HttpReply, type HttpRuntime,
} from "./http.js";
import { decimalToMinorUnits, toNumber } from "./money.js";
import type { AdAccountSummary, AdCampaignMetrics, AdDailyMetrics, AdsAdapter } from "./types.js";

/**
 * Pinned for the same reason as the Google version: Meta keeps a Graph version
 * alive for about two years and changes field shapes between them. Override
 * with `META_ADS_API_VERSION`.
 */
export const META_GRAPH_API_VERSION = "v26.0";
const META_GRAPH_ENDPOINT = "https://graph.facebook.com";
/** A single day of account-level insights is one row. The cap only exists so a
 * malformed `paging.next` cannot spin forever. */
const MAX_PAGES = 50;

/**
 * What counts as a conversion, by default.
 *
 * Meta's `actions` array is not a list of distinct events — it carries
 * overlapping roll-ups, so `purchase`, `omni_purchase` and
 * `offsite_conversion.fb_pixel_purchase` can all describe the *same* sale.
 * Summing everything would double or treble the number on every client report.
 * These three are disjoint sources (pixel purchases, pixel leads, instant-form
 * leads) and are the ones a LaunchFlow client actually buys. Override per
 * deployment with `META_ADS_CONVERSION_ACTIONS`.
 */
export const DEFAULT_META_CONVERSION_ACTIONS: readonly string[] = [
  "offsite_conversion.fb_pixel_purchase",
  "offsite_conversion.fb_pixel_lead",
  "onsite_conversion.lead_grouped",
];

export interface MetaAdsCredentials {
  /** A long-lived system-user token. */
  accessToken?: string | undefined;
  /** Used only to compute `appsecret_proof`; never sent. */
  appSecret?: string | undefined;
}

export interface MetaAdsOptions extends MetaAdsCredentials, AdsHttpOptions {
  apiVersion?: string;
  endpoint?: string;
  conversionActionTypes?: readonly string[];
}

const REQUIRED = ["accessToken", "appSecret"] as const;

const INSIGHTS_FIELDS = "account_currency,spend,impressions,clicks,actions,action_values";
/** The same insights, plus which campaign they belong to. */
const CAMPAIGN_INSIGHTS_FIELDS = `campaign_id,campaign_name,${INSIGHTS_FIELDS}`;

/** One campaign's day, summed in minor units before anything is rounded. */
interface MetaCampaignTotals {
  name: string;
  spendPence: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValuePence: number;
  currency: string;
}

/** Meta's own error codes, which arrive with HTTP 400 as often as with 401/429. */
const AUTH_CODES = new Set([102, 190, 200, 210, 458, 459, 463, 464, 467, 2500]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);

/** `act_123` and `123` both name the same account; the path segment wants `act_123`. */
function normaliseAdAccountId(value: string): string {
  const digits = value.trim().replace(/^act_/i, "").replace(/\D/g, "");
  if (digits.length === 0) {
    throw new TypeError(`meta ads: ad account id has no digits: ${JSON.stringify(value)}`);
  }
  return digits;
}

interface MetaError {
  message: string;
  code: number;
}

function metaError(text: string): MetaError | undefined {
  const parsed = parseJson(text);
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
  const error = parsed.error;
  return {
    message: typeof error.message === "string" ? error.message : text,
    code: toNumber(error.code),
  };
}

function metaFailure(reply: HttpReply): AdsApiError {
  const error = metaError(reply.text);
  const summary = error?.message;
  if (error !== undefined && AUTH_CODES.has(error.code)) {
    return new AdsAuthError("meta", reply.status, reply.text, summary);
  }
  if (error !== undefined && RATE_LIMIT_CODES.has(error.code)) {
    return new AdsRateLimitError("meta", reply.status, reply.text, summary);
  }
  if (reply.status === 401 || reply.status === 403) {
    return new AdsAuthError("meta", reply.status, reply.text, summary);
  }
  if (reply.status === 429) return new AdsRateLimitError("meta", reply.status, reply.text, summary);
  return new AdsApiError("meta", reply.status, reply.text, summary);
}

function isMetaRetryable(reply: HttpReply): boolean {
  if (reply.status === 429 || reply.status >= 500) return true;
  const error = metaError(reply.text);
  return error !== undefined && RATE_LIMIT_CODES.has(error.code);
}

/** Sums the `value` of the action types we count, ignoring the roll-ups. */
function sumActions(list: unknown, types: ReadonlySet<string>, toMinor: boolean): number {
  if (!Array.isArray(list)) return 0;
  let total = 0;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const type = entry.action_type;
    if (typeof type !== "string" || !types.has(type)) continue;
    total += toMinor ? decimalToMinorUnits(entry.value) : toNumber(entry.value);
  }
  return total;
}

/**
 * Meta Ads via the Marketing API.
 *
 * The token goes in an `Authorization` header rather than the query string, so
 * it stays out of URLs (and therefore out of logs and out of the `paging.next`
 * links Meta echoes back). `appsecret_proof` still has to be a query parameter —
 * Graph has no header form for it.
 */
export class MetaAdsAdapter implements AdsAdapter {
  readonly name = "meta" as const;

  private readonly accessToken: string;
  private readonly proof: string;
  private readonly apiVersion: string;
  private readonly endpoint: string;
  private readonly conversionActionTypes: ReadonlySet<string>;
  private readonly http: HttpRuntime;

  constructor(options: MetaAdsOptions) {
    const missing = REQUIRED.filter((key) => !options[key]);
    if (missing.length > 0) {
      throw new Error(`MetaAdsAdapter credentials required: missing ${missing.join(", ")}`);
    }
    this.accessToken = options.accessToken as string;
    this.proof = createHmac("sha256", options.appSecret as string).update(this.accessToken).digest("hex");
    this.apiVersion = options.apiVersion ?? META_GRAPH_API_VERSION;
    this.endpoint = (options.endpoint ?? META_GRAPH_ENDPOINT).replace(/\/+$/, "");
    this.conversionActionTypes = new Set(options.conversionActionTypes ?? DEFAULT_META_CONVERSION_ACTIONS);
    this.http = createHttpRuntime(options);
  }

  async listAccounts(): Promise<AdAccountSummary[]> {
    const rows = await this.getPaged(
      `${this.endpoint}/${this.apiVersion}/me/adaccounts?fields=account_id,name,currency&limit=100`,
    );
    const accounts: AdAccountSummary[] = [];
    for (const row of rows) {
      const accountId = row.account_id;
      const id = typeof accountId === "string" || typeof accountId === "number" ? String(accountId) : "";
      if (id === "") continue;
      const name = typeof row.name === "string" && row.name !== "" ? row.name : `act_${id}`;
      accounts.push({
        externalId: id,
        platform: "meta",
        name,
        currency: typeof row.currency === "string" ? row.currency.toUpperCase() : "",
      });
    }
    return accounts;
  }

  async fetchDailyMetrics(accountId: string, date: string): Promise<AdDailyMetrics> {
    const day = assertIsoDate(date);
    const params = new URLSearchParams({
      fields: INSIGHTS_FIELDS,
      time_increment: "1",
      time_range: JSON.stringify({ since: day, until: day }),
      limit: "100",
    });
    const rows = await this.getPaged(
      `${this.endpoint}/${this.apiVersion}/act_${normaliseAdAccountId(accountId)}/insights?${params.toString()}`,
    );

    let spendPence = 0;
    let impressions = 0;
    let clicks = 0;
    let conversions = 0;
    let conversionValuePence = 0;
    let currency = "";
    for (const row of rows) {
      spendPence += decimalToMinorUnits(row.spend);
      impressions += toNumber(row.impressions);
      clicks += toNumber(row.clicks);
      conversions += sumActions(row.actions, this.conversionActionTypes, false);
      conversionValuePence += sumActions(row.action_values, this.conversionActionTypes, true);
      const code = row.account_currency;
      if (currency === "" && typeof code === "string") currency = code.toUpperCase();
    }

    return {
      date: day,
      spendPence,
      impressions: Math.round(impressions),
      clicks: Math.round(clicks),
      conversions: Math.round(conversions),
      conversionValuePence,
      cpcPence: clicks === 0 ? 0 : spendPence / clicks,
      roas: spendPence === 0 ? 0 : conversionValuePence / spendPence,
      ...(currency === "" ? {} : { currency }),
    };
  }

  /**
   * The same day at `level=campaign`. Graph pages this one for real — an
   * account with thirty campaigns is several pages — which `getPaged` already
   * follows, refusing any cursor pointing somewhere other than the configured
   * endpoint.
   */
  async fetchCampaignMetrics(accountId: string, date: string): Promise<AdCampaignMetrics[]> {
    const day = assertIsoDate(date);
    const params = new URLSearchParams({
      fields: CAMPAIGN_INSIGHTS_FIELDS,
      level: "campaign",
      time_increment: "1",
      time_range: JSON.stringify({ since: day, until: day }),
      limit: "100",
    });
    const rows = await this.getPaged(
      `${this.endpoint}/${this.apiVersion}/act_${normaliseAdAccountId(accountId)}/insights?${params.toString()}`,
    );

    const byCampaign = new Map<string, MetaCampaignTotals>();
    for (const row of rows) {
      const raw = row.campaign_id;
      const id = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
      if (id === "") continue;
      const code = row.account_currency;
      const existing = byCampaign.get(id) ?? {
        name: typeof row.campaign_name === "string" && row.campaign_name !== "" ? row.campaign_name : id,
        spendPence: 0, impressions: 0, clicks: 0, conversions: 0, conversionValuePence: 0,
        currency: typeof code === "string" ? code.toUpperCase() : "",
      };
      byCampaign.set(id, {
        ...existing,
        spendPence: existing.spendPence + decimalToMinorUnits(row.spend),
        impressions: existing.impressions + toNumber(row.impressions),
        clicks: existing.clicks + toNumber(row.clicks),
        conversions: existing.conversions + sumActions(row.actions, this.conversionActionTypes, false),
        conversionValuePence: existing.conversionValuePence + sumActions(row.action_values, this.conversionActionTypes, true),
      });
    }

    return [...byCampaign].map(([campaignExternalId, totals]) => ({
      date: day,
      campaignExternalId,
      campaignName: totals.name,
      spendPence: totals.spendPence,
      impressions: Math.round(totals.impressions),
      clicks: Math.round(totals.clicks),
      conversions: Math.round(totals.conversions),
      conversionValuePence: totals.conversionValuePence,
      ...(totals.currency === "" ? {} : { currency: totals.currency }),
    }));
  }

  /** Follows `paging.next` until Graph stops offering one. */
  private async getPaged(firstUrl: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let next: string | undefined = firstUrl;
    for (let page = 0; next !== undefined && page < MAX_PAGES; page += 1) {
      const payload: Record<string, unknown> = await this.get(next);
      const data = payload.data;
      if (Array.isArray(data)) {
        for (const row of data) if (isRecord(row)) rows.push(row);
      }
      next = this.nextPageUrl(payload);
    }
    return rows;
  }

  /**
   * The cursor Meta hands back, refused unless it points at the endpoint we
   * configured. We attach an `Authorization` header to whatever URL comes out
   * of here, so following a host from a response body unchecked would be a way
   * to post the token somewhere else.
   */
  private nextPageUrl(payload: Record<string, unknown>): string | undefined {
    const paging = payload.paging;
    if (!isRecord(paging)) return undefined;
    const next = paging.next;
    if (typeof next !== "string" || next === "") return undefined;
    if (!next.startsWith(`${this.endpoint}/`)) return undefined;
    return next;
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    const reply = await sendWithRetry(this.http, {
      url: this.withProof(url),
      init: { method: "GET", headers: { authorization: `Bearer ${this.accessToken}` } },
    }, isMetaRetryable);
    if (!reply.ok) throw metaFailure(reply);

    const parsed = parseJson(reply.text);
    if (!isRecord(parsed)) {
      throw new AdsApiError("meta", reply.status, reply.text, "response body was not a JSON object");
    }
    // Graph occasionally answers 200 with an error envelope rather than data.
    if (isRecord(parsed.error)) throw metaFailure({ ...reply, ok: false });
    return parsed;
  }

  private withProof(url: string): string {
    if (url.includes("appsecret_proof=")) return url;
    return `${url}${url.includes("?") ? "&" : "?"}appsecret_proof=${this.proof}`;
  }
}
