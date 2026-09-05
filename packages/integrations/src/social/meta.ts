import { createHmac } from "node:crypto";
import {
  createHttpRuntime, isRecord, parseJson, sendWithRetry,
  type AdsHttpOptions, type HttpReply, type HttpRuntime,
} from "../ads/http.js";
import { SocialApiError, SocialInvalidMediaError } from "./errors.js";
import { graphFailure, isGraphRetryable } from "./graph-error.js";
import type { SocialChannel, SocialPublishInput, SocialPublishResult, SocialPublisher } from "./types.js";

/**
 * Facebook Pages and Instagram Business accounts through the Graph API, plain
 * `fetch`, no SDK — the same choice `ads/meta.ts` made, for the same reasons.
 *
 * **Tokens.** One system-user token (`META_ADS_ACCESS_TOKEN`) is the credential
 * for everything. Posting to a Page's feed needs a *Page* access token, which
 * is read once per page from `GET /{pageId}?fields=access_token` and cached
 * for the life of the process. Instagram calls use the system-user token
 * directly. `appsecret_proof` is an HMAC of whichever token a call carries, so
 * there is one proof per token, computed once.
 *
 * **Required permissions** on the system-user token (Business Settings →
 * System users → Generate token → pick the app → tick these):
 *
 * - `pages_manage_posts` — create posts and photos on the Page.
 * - `pages_read_engagement` — read the Page (needed alongside the above to
 *   fetch the Page token and the post permalink).
 * - `instagram_basic` — read the Instagram Business account.
 * - `instagram_content_publish` — create and publish Instagram media.
 *
 * The Page and the Instagram account must both be assets of the system user
 * (Business Settings → System users → Add assets → Pages), and the Instagram
 * account must be a Business or Creator account connected to that Page.
 * `ads_read` / `read_insights` from the ads adapter can sit on the same token.
 *
 * **Instagram is two steps with a wait in the middle.** `POST /{igUserId}/media`
 * creates a *container* that Meta fetches the image into; `media_publish` is
 * refused until its `status_code` is `FINISHED`. The poll is bounded
 * (`pollAttempts` × `pollIntervalMs`) so a container that never finishes turns
 * into a `timeout` error, not a stuck worker.
 */
export const META_GRAPH_API_VERSION = "v26.0";
const META_GRAPH_ENDPOINT = "https://graph.facebook.com";
const DEFAULT_POLL_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface MetaSocialCredentials {
  /** The long-lived system-user token. */
  accessToken?: string | undefined;
  /** Used only to compute `appsecret_proof`; never sent. */
  appSecret?: string | undefined;
}

export type SocialHttpOptions = AdsHttpOptions;

export interface MetaSocialOptions extends MetaSocialCredentials, SocialHttpOptions {
  apiVersion?: string;
  endpoint?: string;
  /** How many times to ask an Instagram container for its status before giving up. */
  pollAttempts?: number;
  /** The wait between those asks. Goes through `sleep`, so tests do not wait. */
  pollIntervalMs?: number;
}

const REQUIRED = ["accessToken", "appSecret"] as const;

/** Graph rejects a path segment that is not a plain id; the check is here so the error names the field. */
function assertGraphId(value: string, what: string): string {
  const trimmed = value.trim();
  if (!/^[\w.-]+$/.test(trimmed)) {
    throw new TypeError(`meta social: ${what} is not a Graph id: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** `text` with the link on its own line after it, unless it is already in there. */
function captionWithLink(text: string, linkUrl: string | undefined): string {
  if (!linkUrl || text.includes(linkUrl)) return text;
  return `${text.trimEnd()}\n\n${linkUrl}`;
}

function idOf(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value !== "" ? value : typeof value === "number" ? String(value) : undefined;
}

export class MetaSocialPublisher implements SocialPublisher {
  readonly name = "meta" as const;

  private readonly systemToken: string;
  private readonly appSecret: string;
  private readonly apiVersion: string;
  private readonly endpoint: string;
  private readonly pollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly http: HttpRuntime;
  private readonly pageTokens = new Map<string, string>();
  private readonly proofs = new Map<string, string>();

  constructor(options: MetaSocialOptions) {
    const missing = REQUIRED.filter((key) => !options[key]);
    if (missing.length > 0) {
      throw new Error(`MetaSocialPublisher credentials required: missing ${missing.join(", ")}`);
    }
    this.systemToken = options.accessToken as string;
    this.appSecret = options.appSecret as string;
    this.apiVersion = options.apiVersion ?? META_GRAPH_API_VERSION;
    this.endpoint = (options.endpoint ?? META_GRAPH_ENDPOINT).replace(/\/+$/, "");
    this.pollAttempts = Math.max(1, options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.http = createHttpRuntime(options);
  }

  async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
    return input.channel === "instagram" ? this.publishInstagram(input) : this.publishFacebook(input);
  }

  // ---- Facebook ----------------------------------------------------------

  private async publishFacebook(input: SocialPublishInput): Promise<SocialPublishResult> {
    const pageId = assertGraphId(input.externalId, "Facebook page id");
    const token = await this.pageToken(pageId);
    const externalId = input.imageUrl
      ? await this.facebookPhoto(pageId, token, input)
      : await this.facebookFeed(pageId, token, input);
    const url = await this.permalink("facebook", externalId, token, "permalink_url");
    return url === undefined ? { externalId } : { externalId, url };
  }

  /** `POST /{pageId}/feed` — a text post, with `link` as the preview attachment when given. */
  private async facebookFeed(pageId: string, token: string, input: SocialPublishInput): Promise<string> {
    const payload = await this.post("facebook", `${pageId}/feed`, token, {
      message: input.text,
      ...(input.linkUrl ? { link: input.linkUrl } : {}),
    });
    const id = idOf(payload, "id");
    if (id === undefined) throw new SocialApiError("facebook", 200, JSON.stringify(payload), "feed post returned no id");
    return id;
  }

  /**
   * `POST /{pageId}/photos` — a photo post. Graph answers with the photo's own
   * `id` and the `post_id` of the feed story it created; the story is what has
   * a permalink and what a client sees, so that is the id kept.
   */
  private async facebookPhoto(pageId: string, token: string, input: SocialPublishInput): Promise<string> {
    const payload = await this.post("facebook", `${pageId}/photos`, token, {
      url: input.imageUrl,
      caption: captionWithLink(input.text, input.linkUrl),
    });
    const id = idOf(payload, "post_id") ?? idOf(payload, "id");
    if (id === undefined) throw new SocialApiError("facebook", 200, JSON.stringify(payload), "photo post returned no id");
    return id;
  }

  /**
   * The Page token, from the system-user token, cached per page. A Page token
   * issued to a system user does not expire, so there is nothing to refresh;
   * one that stops working is dropped by `post` on the auth error so the next
   * attempt fetches it again.
   */
  private async pageToken(pageId: string): Promise<string> {
    const cached = this.pageTokens.get(pageId);
    if (cached !== undefined) return cached;
    const payload = await this.get("facebook", `${pageId}?fields=access_token`, this.systemToken);
    const token = idOf(payload, "access_token");
    if (token === undefined) {
      throw new SocialApiError(
        "facebook", 200, JSON.stringify(payload),
        `page ${pageId} returned no access_token — is the Page an asset of the system user, with pages_manage_posts?`,
      );
    }
    this.pageTokens.set(pageId, token);
    return token;
  }

  // ---- Instagram ---------------------------------------------------------

  private async publishInstagram(input: SocialPublishInput): Promise<SocialPublishResult> {
    const igUserId = assertGraphId(input.externalId, "Instagram user id");
    if (!input.imageUrl) {
      throw new SocialInvalidMediaError("instagram", 0, "", "Instagram has no text-only post; an image is required");
    }
    const token = this.systemToken;
    const creationId = await this.instagramContainer(igUserId, token, input);
    await this.awaitContainer(creationId, token);
    const payload = await this.post("instagram", `${igUserId}/media_publish`, token, { creation_id: creationId });
    const externalId = idOf(payload, "id");
    if (externalId === undefined) {
      throw new SocialApiError("instagram", 200, JSON.stringify(payload), "media_publish returned no id");
    }
    const url = await this.permalink("instagram", externalId, token, "permalink");
    return url === undefined ? { externalId } : { externalId, url };
  }

  private async instagramContainer(igUserId: string, token: string, input: SocialPublishInput): Promise<string> {
    const payload = await this.post("instagram", `${igUserId}/media`, token, {
      image_url: input.imageUrl,
      caption: captionWithLink(input.text, input.linkUrl),
    });
    const id = idOf(payload, "id");
    if (id === undefined) throw new SocialApiError("instagram", 200, JSON.stringify(payload), "media container returned no id");
    return id;
  }

  /**
   * `GET /{creationId}?fields=status_code,status` until `FINISHED`. `ERROR` and
   * `EXPIRED` are the container saying the image could not be used; running
   * out of attempts is a timeout the next run may not see again.
   */
  private async awaitContainer(creationId: string, token: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const payload = await this.get("instagram", `${creationId}?fields=status_code,status`, token);
      const status = typeof payload.status_code === "string" ? payload.status_code.toUpperCase() : "";
      if (status === "FINISHED") return;
      if (status === "ERROR" || status === "EXPIRED") {
        const why = typeof payload.status === "string" ? payload.status : status;
        throw new SocialInvalidMediaError("instagram", 200, JSON.stringify(payload), `media container ${status}: ${why}`);
      }
      if (attempt >= this.pollAttempts) {
        throw new SocialApiError(
          "instagram", 200, JSON.stringify(payload),
          `media container ${creationId} still ${status || "pending"} after ${attempt} checks`, "timeout",
        );
      }
      await this.http.sleep(this.pollIntervalMs);
    }
  }

  // ---- Shared ------------------------------------------------------------

  /**
   * The public link, best effort. By the time this runs the post exists, so a
   * failure is swallowed: reporting it would make the publish job mark the
   * item failed and post it again on the next run.
   */
  private async permalink(channel: SocialChannel, id: string, token: string, field: string): Promise<string | undefined> {
    try {
      const payload = await this.get(channel, `${id}?fields=${field}`, token);
      return idOf(payload, field);
    } catch {
      return undefined;
    }
  }

  private async get(channel: SocialChannel, path: string, token: string): Promise<Record<string, unknown>> {
    return this.send(channel, "GET", path, token, undefined);
  }

  private async post(channel: SocialChannel, path: string, token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send(channel, "POST", path, token, body);
  }

  /**
   * One Graph call. The token is a bearer header, never a query parameter, so
   * it stays out of URLs and logs; `appsecret_proof` has to be a parameter
   * because Graph has no header form for it.
   */
  private async send(
    channel: SocialChannel, method: "GET" | "POST", path: string, token: string, body: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.endpoint}/${this.apiVersion}/${path}${separator}appsecret_proof=${this.proofFor(token)}`;
    const reply = await sendWithRetry(this.http, {
      url,
      init: {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    }, isGraphRetryable(method));

    if (!reply.ok) throw this.failure(channel, reply, token);
    const parsed = parseJson(reply.text);
    if (!isRecord(parsed)) {
      throw new SocialApiError(channel, reply.status, reply.text, "response body was not a JSON object");
    }
    // Graph occasionally answers 200 with an error envelope rather than data.
    if (isRecord(parsed.error)) throw this.failure(channel, { ...reply, ok: false }, token);
    return parsed;
  }

  private failure(channel: SocialChannel, reply: HttpReply, token: string): SocialApiError {
    const error = graphFailure(channel, reply);
    if (error.code === "auth" && token !== this.systemToken) this.forgetPageToken(token);
    return error;
  }

  private forgetPageToken(token: string): void {
    for (const [pageId, cached] of this.pageTokens) {
      if (cached === token) this.pageTokens.delete(pageId);
    }
    this.proofs.delete(token);
  }

  private proofFor(token: string): string {
    const cached = this.proofs.get(token);
    if (cached !== undefined) return cached;
    const proof = createHmac("sha256", this.appSecret).update(token).digest("hex");
    this.proofs.set(token, proof);
    return proof;
  }
}
