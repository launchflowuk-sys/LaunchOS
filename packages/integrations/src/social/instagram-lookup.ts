import { createHmac } from "node:crypto";
import { createHttpRuntime, isRecord, parseJson, sendWithRetry, type AdsHttpOptions } from "../ads/http.js";
import { SocialApiError, SocialAuthError } from "./errors.js";
import { graphFailure, isGraphRetryable } from "./graph-error.js";
import { META_GRAPH_API_VERSION } from "./meta.js";

/**
 * The Instagram Business account connected to a Facebook Page, so the
 * Channels form can fill the Instagram id from the Page id a client already
 * gave us rather than asking them to dig it out of Meta Business Suite.
 *
 * One Graph call — `GET /{pageId}?fields=instagram_business_account{id,username}`
 * — with the same system-user token and `appsecret_proof` as
 * `MetaSocialPublisher`, and the same Page requirements: the Page must be an
 * asset of the system user, and the token needs `pages_read_engagement` and
 * `instagram_basic`. A Page with no connected Business or Creator account
 * answers without the field, which is `null` here.
 */

const META_GRAPH_ENDPOINT = "https://graph.facebook.com";

export interface InstagramAccount {
  readonly id: string;
  /** Absent from Graph when the token lacks `instagram_basic`; the id still identifies the account. */
  readonly username: string | null;
}

export interface InstagramLookupOptions extends AdsHttpOptions {
  apiVersion?: string;
  endpoint?: string;
}

/** Graph rejects a path segment that is not a plain id; the check is here so the error names the field. */
function assertGraphId(value: string): string {
  const trimmed = value.trim();
  if (!/^[\w.-]+$/.test(trimmed)) {
    throw new TypeError(`instagram lookup: Facebook page id is not a Graph id: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : typeof value === "number" ? String(value) : undefined;
}

/**
 * `{ id, username }` for the Instagram account connected to `pageId`, `null`
 * when the Page has none. Throws `SocialAuthError` when the Meta keys are not
 * set — a Channels form must say "waiting for Meta access", not "no Instagram
 * account" — and the usual `SocialApiError` family for a Graph refusal.
 */
export async function lookupInstagramForPage(
  pageId: string,
  env: NodeJS.ProcessEnv,
  options: InstagramLookupOptions = {},
): Promise<InstagramAccount | null> {
  const accessToken = env.META_ADS_ACCESS_TOKEN?.trim();
  const appSecret = env.META_ADS_APP_SECRET?.trim();
  if (!accessToken || !appSecret) {
    throw new SocialAuthError("instagram", 0, "", "META_ADS_ACCESS_TOKEN and META_ADS_APP_SECRET are not set; connect Meta first");
  }
  const id = assertGraphId(pageId);
  const apiVersion = options.apiVersion ?? env.META_ADS_API_VERSION?.trim() ?? META_GRAPH_API_VERSION;
  const endpoint = (options.endpoint ?? META_GRAPH_ENDPOINT).replace(/\/+$/, "");
  const proof = createHmac("sha256", appSecret).update(accessToken).digest("hex");
  const url = `${endpoint}/${apiVersion}/${id}?fields=instagram_business_account{id,username}&appsecret_proof=${proof}`;

  const reply = await sendWithRetry(createHttpRuntime(options), {
    url,
    // The token is a bearer header, never a query parameter, so it stays out of URLs and logs.
    init: { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
  }, isGraphRetryable("GET"));
  if (!reply.ok) throw graphFailure("instagram", reply);

  const payload = parseJson(reply.text);
  if (!isRecord(payload)) throw new SocialApiError("instagram", reply.status, reply.text, "response body was not a JSON object");
  if (isRecord(payload.error)) throw graphFailure("instagram", { ...reply, ok: false });

  const account = payload.instagram_business_account;
  if (!isRecord(account)) return null;
  const accountId = stringOf(account.id);
  if (accountId === undefined) return null;
  return { id: accountId, username: stringOf(account.username) ?? null };
}
