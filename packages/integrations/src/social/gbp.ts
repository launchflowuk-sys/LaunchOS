import {
  createHttpRuntime, isRecord, parseJson, sendWithRetry,
  type AdsHttpOptions, type HttpReply, type HttpRuntime,
} from "../ads/http.js";
import { SocialApiError, SocialAuthError, SocialInvalidMediaError, SocialRateLimitError } from "./errors.js";
import { GoogleOAuthTokenSource } from "./gbp-oauth.js";
import type { SocialPublishInput, SocialPublishResult, SocialPublisher } from "./types.js";

/**
 * Google Business Profile updates ("local posts"), plain `fetch`, no SDK.
 *
 * **Which API.** Google split the old "My Business" API into several. Posts
 * still live only on the **v4** surface
 * (`mybusiness.googleapis.com/v4/{account}/{location}/localPosts`); accounts
 * and locations are enumerated through the newer Account Management and
 * Business Information APIs. All three sit behind one OAuth scope,
 * `https://www.googleapis.com/auth/business.manage`, and one Cloud project
 * that Google has to approve for Business Profile API access before any of
 * them answer anything but 403.
 *
 * **Credentials.** `GBP_CLIENT_ID` + `GBP_CLIENT_SECRET` (an OAuth client on
 * that project) and `GBP_REFRESH_TOKEN` (minted once through the OAuth
 * Playground as the Google account that manages the clients' profiles). The
 * refresh token is swapped for a short-lived access token on first use and
 * cached until it is about to expire — see `gbp-oauth.ts`.
 *
 * **What goes in `content_channels.external_id`.** The location *resource
 * name*, `accounts/{accountId}/locations/{locationId}` — not the bare
 * location id, and not the `locations/{id}` short form the v1 API returns,
 * because v4 wants the account in the path. `listLocations()` returns the
 * names in exactly that form so the admin screen can store them as they are.
 *
 * **Retry.** A 429 is retried once for every call: Google rejected it, so
 * nothing was posted. A 5xx is retried only for GETs — a `POST …/localPosts`
 * that died on Google's side may have created the post, and a second send
 * would put the same update on the profile twice.
 */
export const GBP_API_ENDPOINT = "https://mybusiness.googleapis.com/v4";
export const GBP_ACCOUNTS_ENDPOINT = "https://mybusinessaccountmanagement.googleapis.com/v1";
export const GBP_LOCATIONS_ENDPOINT = "https://mybusinessbusinessinformation.googleapis.com/v1";
export const GBP_OAUTH_SCOPE = "https://www.googleapis.com/auth/business.manage";
/** Google's limit on a local post's `summary`. Checked here so a long draft is refused before anything is sent. */
export const GBP_SUMMARY_MAX_CHARS = 1500;
export const GBP_LANGUAGE_CODE = "en-GB";
/** Location resource name as the v4 API wants it in a path. */
const LOCATION_NAME = /^accounts\/\d+\/locations\/\d+$/;
/** How many pages of accounts or locations `listLocations` will follow. Nobody manages a thousand profiles from one login. */
const MAX_LIST_PAGES = 10;

export interface GbpCredentials {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  refreshToken?: string | undefined;
}

export interface GbpOptions extends GbpCredentials, AdsHttpOptions {
  /** The v4 posts endpoint. Tests point it at a stub. */
  endpoint?: string;
  accountsEndpoint?: string;
  locationsEndpoint?: string;
  tokenUrl?: string;
}

export interface GbpLocation {
  /** `accounts/{accountId}/locations/{locationId}` — store this as `content_channels.external_id`. */
  readonly name: string;
  /** The business name as it appears on the profile. */
  readonly title: string;
  /** The owning account's display name, so a list spanning accounts reads sensibly. */
  readonly accountName: string;
}

const REQUIRED = ["clientId", "clientSecret", "refreshToken"] as const;

function assertLocationName(value: string): string {
  const trimmed = value.trim();
  if (!LOCATION_NAME.test(trimmed)) {
    throw new TypeError(
      `gbp: externalId must be a location resource name accounts/{accountId}/locations/{locationId}, got ${JSON.stringify(value)}`,
    );
  }
  return trimmed;
}

function assertSummary(text: string): string {
  const length = [...text].length;
  if (length > GBP_SUMMARY_MAX_CHARS) {
    throw new TypeError(`gbp: summary is ${length} characters; Google Business Profile allows at most ${GBP_SUMMARY_MAX_CHARS}`);
  }
  if (text.trim() === "") throw new TypeError("gbp: summary is empty");
  return text;
}

/** Google's error envelope: `{ error: { code, message, status } }`. */
function googleError(text: string): { message: string; status: string } {
  const parsed = parseJson(text);
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  return {
    message: typeof error?.message === "string" ? error.message : text,
    status: typeof error?.status === "string" ? error.status : "",
  };
}

/**
 * The v4 API has no dedicated media error code; a photo it cannot fetch or
 * will not accept comes back as `INVALID_ARGUMENT` with the media named in the
 * message. Anything else on 400 is a request the worker should not repeat.
 */
function isMediaComplaint(message: string): boolean {
  return /\b(media|photo|image|picture)\b/i.test(message);
}

function gbpFailure(reply: HttpReply): SocialApiError {
  const { message, status } = googleError(reply.text);
  // 403 is what an un-enabled API, an unapproved project and a location the
  // account does not manage all look like — every one of them needs a human.
  if (reply.status === 401 || reply.status === 403) return new SocialAuthError("gbp", reply.status, reply.text, message);
  if (reply.status === 429 || status === "RESOURCE_EXHAUSTED") return new SocialRateLimitError("gbp", reply.status, reply.text, message);
  if (reply.status === 400 && isMediaComplaint(message)) return new SocialInvalidMediaError("gbp", reply.status, reply.text, message);
  return new SocialApiError("gbp", reply.status, reply.text, message);
}

function isGbpRetryable(method: "GET" | "POST"): (reply: HttpReply) => boolean {
  return (reply) => {
    if (reply.status === 429) return true;
    if (reply.status >= 500) return method === "GET";
    return googleError(reply.text).status === "RESOURCE_EXHAUSTED";
  };
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function recordsIn(payload: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = payload[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export class GbpPublisher implements SocialPublisher {
  readonly name = "gbp" as const;

  private readonly endpoint: string;
  private readonly accountsEndpoint: string;
  private readonly locationsEndpoint: string;
  private readonly http: HttpRuntime;
  private readonly tokens: GoogleOAuthTokenSource;

  constructor(options: GbpOptions) {
    const missing = REQUIRED.filter((key) => !options[key]);
    if (missing.length > 0) {
      throw new Error(`GbpPublisher credentials required: missing ${missing.join(", ")}`);
    }
    this.endpoint = (options.endpoint ?? GBP_API_ENDPOINT).replace(/\/+$/, "");
    this.accountsEndpoint = (options.accountsEndpoint ?? GBP_ACCOUNTS_ENDPOINT).replace(/\/+$/, "");
    this.locationsEndpoint = (options.locationsEndpoint ?? GBP_LOCATIONS_ENDPOINT).replace(/\/+$/, "");
    this.http = createHttpRuntime(options);
    this.tokens = new GoogleOAuthTokenSource(
      { clientId: options.clientId as string, clientSecret: options.clientSecret as string, refreshToken: options.refreshToken as string },
      this.http,
      options.tokenUrl,
    );
  }

  /**
   * `POST {location}/localPosts` — a STANDARD update. The input is checked in
   * full before the token is even fetched, so a bad location or an over-long
   * summary costs nothing on the wire.
   */
  async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
    if (input.channel !== "gbp") {
      throw new TypeError(`gbp: cannot publish to channel ${JSON.stringify(input.channel)}`);
    }
    const location = assertLocationName(input.externalId);
    const summary = assertSummary(input.text);
    const body = {
      languageCode: GBP_LANGUAGE_CODE,
      topicType: "STANDARD",
      summary,
      ...(input.linkUrl ? { callToAction: { actionType: "LEARN_MORE", url: input.linkUrl } } : {}),
      ...(input.imageUrl ? { media: [{ mediaFormat: "PHOTO", sourceUrl: input.imageUrl }] } : {}),
    };
    const payload = await this.send("POST", `${this.endpoint}/${location}/localPosts`, body);
    const externalId = stringField(payload, "name");
    if (externalId === undefined) {
      throw new SocialApiError("gbp", 200, JSON.stringify(payload), "localPosts returned no name");
    }
    const url = stringField(payload, "searchUrl");
    return url === undefined ? { externalId } : { externalId, url };
  }

  /**
   * Every location the signed-in Google account can post to, across all of its
   * Business Profile accounts, named the way `publish` wants them. For the
   * admin's "pick a location" control; not called by the publish job.
   */
  async listLocations(): Promise<GbpLocation[]> {
    const locations: GbpLocation[] = [];
    for (const account of await this.listAccounts()) {
      const accountName = stringField(account, "name");
      if (accountName === undefined) continue;
      const accountTitle = stringField(account, "accountName") ?? accountName;
      const path = `${this.locationsEndpoint}/${accountName}/locations?readMask=name,title`;
      for (const location of await this.paged(path, "locations")) {
        const short = stringField(location, "name");
        if (short === undefined) continue;
        // v1 answers `locations/{id}`; v4 wants `accounts/{a}/locations/{id}`.
        const name = short.startsWith("accounts/") ? short : `${accountName}/${short}`;
        locations.push({ name, title: stringField(location, "title") ?? name, accountName: accountTitle });
      }
    }
    return locations;
  }

  private async listAccounts(): Promise<Record<string, unknown>[]> {
    return this.paged(`${this.accountsEndpoint}/accounts`, "accounts");
  }

  /** Follows `nextPageToken` for a bounded number of pages. */
  private async paged(url: string, field: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const separator = url.includes("?") ? "&" : "?";
      const pageUrl = pageToken === undefined ? url : `${url}${separator}pageToken=${encodeURIComponent(pageToken)}`;
      const payload = await this.send("GET", pageUrl, undefined);
      items.push(...recordsIn(payload, field));
      pageToken = stringField(payload, "nextPageToken");
      if (pageToken === undefined) break;
    }
    return items;
  }

  /** One authenticated call. The token is a bearer header, never a query parameter. */
  private async send(method: "GET" | "POST", url: string, body: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const accessToken = await this.tokens.accessToken();
    const reply = await sendWithRetry(this.http, {
      url,
      init: {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    }, isGbpRetryable(method));

    if (!reply.ok) {
      // A 401 is nearly always a token cached before the grant changed; drop it
      // so the next call refreshes rather than replaying it.
      if (reply.status === 401) this.tokens.forget();
      throw gbpFailure(reply);
    }
    const parsed = parseJson(reply.text);
    if (!isRecord(parsed)) {
      throw new SocialApiError("gbp", reply.status, reply.text, "response body was not a JSON object");
    }
    return parsed;
  }
}
