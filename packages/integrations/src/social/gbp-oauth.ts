import { isRecord, parseJson, sendWithRetry, type HttpRuntime } from "../ads/http.js";
import { toNumber } from "../ads/money.js";
import { SocialApiError, SocialAuthError } from "./errors.js";

/**
 * Google's refresh-token grant, for the Business Profile publisher.
 *
 * This is the token dance `ads/google.ts` does, copied rather than imported:
 * that file is the ads adapter's, it exposes the refresh as a private method
 * of a class that also wants a developer token and a manager account, and
 * pulling a shared helper out of it would touch another phase's module for a
 * dozen lines. If a third Google API ever lands, lift both into one.
 */
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh a minute early so a token cannot expire mid-flight. */
const TOKEN_SKEW_SECONDS = 60;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Cached until just before expiry, and single-flighted so a batch of publishes
 * does not open one refresh per post. `forget()` drops a token the API just
 * answered 401 to, so the next call re-refreshes rather than replaying the
 * dead one for the life of the worker.
 */
export class GoogleOAuthTokenSource {
  private token: { value: string; expiresAtMs: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly credentials: GoogleOAuthCredentials,
    private readonly http: HttpRuntime,
    private readonly tokenUrl: string = GOOGLE_OAUTH_TOKEN_URL,
  ) {}

  async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  forget(): void {
    this.token = null;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
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
      const code = typeof payload.error === "string" ? payload.error : undefined;
      const description = typeof payload.error_description === "string" ? payload.error_description : undefined;
      const summary = [code, description].filter((part) => part !== undefined).join(": ");
      const detail = summary === "" ? undefined : `token refresh failed: ${summary}`;
      // Everything below 500 from the token endpoint is a credential problem —
      // invalid_grant (revoked or expired refresh token), invalid_client (wrong
      // secret), unauthorized_client. None of them get better on a retry.
      if (reply.status < 500) throw new SocialAuthError("gbp", reply.status, reply.text, detail);
      throw new SocialApiError("gbp", reply.status, reply.text, detail);
    }

    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (accessToken === "") {
      throw new SocialAuthError("gbp", reply.status, reply.text, "token endpoint returned no access_token");
    }
    const expiresIn = toNumber(payload.expires_in) || DEFAULT_EXPIRES_IN_SECONDS;
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
