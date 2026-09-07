import { createSign } from "node:crypto";
import { isRecord, parseJson, sendWithRetry, type HttpRuntime } from "../ads/http.js";
import { SearchConsoleAuthError, SearchConsoleError } from "./errors.js";

/**
 * A service account's own access token, no user and no refresh token.
 *
 * `social/gbp-oauth.ts` does the refresh-token grant, because Business Profile
 * has no other option — a service account cannot own a location. Search Console
 * does have the option, and it is the better one:
 *
 * - Its scopes are **sensitive**, so an OAuth app left in Testing status has
 *   refresh tokens that expire every seven days. The integration would work for
 *   a week and then quietly stop. Escaping that means Google app verification,
 *   a review process for an app one person uses.
 * - A service account authenticates as itself. Access to each property is
 *   granted inside Search Console and revoked there, which is also the only
 *   sane thing to ask a *client* to do: add an email address as a Restricted
 *   user, rather than run a consent flow against an unverified app.
 *
 * The grant is RFC 7523: sign a short-lived assertion with the account's
 * private key and trade it for an access token. `node:crypto` signs it — the
 * alternative is `google-auth-library`, which brings a transitive tree for
 * forty lines of work.
 *
 * Caching and single-flight are deliberately the same shape as
 * `GoogleOAuthTokenSource`. There are now three Google auth paths in this
 * package (ads, gbp, here) and two distinct grants between them; when a fourth
 * lands, lift the caching half into one place and leave the grant bodies apart.
 */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Read-only. The adapter never writes, so it never asks to. */
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Refresh a minute early so a token cannot expire mid-flight. */
const TOKEN_SKEW_SECONDS = 60;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
/** Google rejects an assertion claiming more than an hour. */
const ASSERTION_LIFETIME_SECONDS = 3600;

export interface ServiceAccountCredentials {
  readonly clientEmail: string;
  /** PEM, `-----BEGIN PRIVATE KEY-----` and all. */
  readonly privateKey: string;
}

function base64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Read a downloaded key file into the two fields that matter.
 *
 * Accepts the raw JSON or a base64 wrapper of it, because that is what survives
 * a deploy: the PEM contains newlines, and every environment-variable editor in
 * the world does something different to those. Base64 has no newlines to lose.
 *
 * `\n` written as two literal characters is repaired here — the other way a PEM
 * arrives broken, from anyone who pasted the JSON string into a form.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountCredentials {
  const trimmed = raw.trim();
  if (trimmed === "") throw new SearchConsoleError(0, "", "service account key is empty");

  const text = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = parseJson(text);
  if (!isRecord(parsed)) {
    throw new SearchConsoleError(0, "", "service account key is not JSON — expected the downloaded key file, or that file base64-encoded");
  }

  const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
  const privateKeyRaw = typeof parsed.private_key === "string" ? parsed.private_key : "";
  if (clientEmail === "" || privateKeyRaw === "") {
    throw new SearchConsoleError(0, "", "service account key has no client_email or private_key");
  }

  return { clientEmail, privateKey: privateKeyRaw.replace(/\\n/g, "\n") };
}

export class ServiceAccountTokenSource {
  private token: { value: string; expiresAtMs: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly credentials: ServiceAccountCredentials,
    private readonly http: HttpRuntime,
    private readonly scope: string = SEARCH_CONSOLE_SCOPE,
    private readonly tokenUrl: string = GOOGLE_TOKEN_URL,
  ) {}

  async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;
    this.refreshing ??= this.mint().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Drop a token the API just answered 401 to, so the next call mints rather than replaying a dead one. */
  forget(): void {
    this.token = null;
  }

  private assertion(nowSeconds: number): string {
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(JSON.stringify({
      iss: this.credentials.clientEmail,
      scope: this.scope,
      aud: this.tokenUrl,
      iat: nowSeconds,
      exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
    }));
    const signingInput = `${header}.${claims}`;

    try {
      const signature = createSign("RSA-SHA256").update(signingInput).end().sign(this.credentials.privateKey);
      return `${signingInput}.${base64Url(signature)}`;
    } catch (cause) {
      // A malformed PEM lands here, and the raw message ("error:1E08010C:DECODER
      // routines::unsupported") tells the reader nothing about what to fix.
      throw new SearchConsoleAuthError(0, cause instanceof Error ? cause.message : String(cause), "could not sign with the service account private key — the key looks malformed");
    }
  }

  private async mint(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: this.assertion(Math.floor(Date.now() / 1000)),
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
      const code = typeof payload.error === "string" ? payload.error : undefined;
      const description = typeof payload.error_description === "string" ? payload.error_description : undefined;
      const summary = [code, description].filter((part) => part !== undefined).join(": ");
      const detail = summary === "" ? undefined : `token request failed: ${summary}`;
      // Below 500 from the token endpoint is always the credential itself —
      // invalid_grant (clock skew, or a deleted key), invalid_client (the
      // account is gone). None improve on a retry.
      if (reply.status < 500) throw new SearchConsoleAuthError(reply.status, reply.text, detail);
      throw new SearchConsoleError(reply.status, reply.text, detail);
    }

    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (accessToken === "") {
      throw new SearchConsoleAuthError(reply.status, reply.text, "token endpoint returned no access_token");
    }
    const expiresInRaw = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
    const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : DEFAULT_EXPIRES_IN_SECONDS;
    // Floored at zero rather than at the skew: a token living less than the
    // skew is cached for no time and re-fetched, never kept past its validity.
    this.token = {
      value: accessToken,
      expiresAtMs: Date.now() + Math.max(0, expiresIn - TOKEN_SKEW_SECONDS) * 1000,
    };
    return accessToken;
  }
}
