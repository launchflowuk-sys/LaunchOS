import { MeetingsApiError, type CreateMeetingInput, type MeetingsAdapter, type ProviderMeeting, type UpdateMeetingInput } from "./types.js";

export interface ZoomMeetingsConfig {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

export interface ZoomMeetingsOptions {
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined;
  /** Injected in tests, so an expiring token can be simulated. */
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
  tokenEndpoint?: string | undefined;
  apiBase?: string | undefined;
}

export const ZOOM_TOKEN_ENDPOINT = "https://zoom.us/oauth/token";
export const ZOOM_API_BASE = "https://api.zoom.us/v2";
export const ZOOM_DEFAULT_TIMEOUT_MS = 15_000;
/** A token is refreshed this long before Zoom says it expires, so a request never races the expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** The settings every LaunchFlow call is created with. Waiting room on: a stranger with the link still waits for Shoji. */
export const ZOOM_MEETING_SETTINGS = {
  join_before_host: false,
  waiting_room: true,
  auto_recording: "cloud",
} as const;

interface TokenResponse { access_token: string; expires_in: number; token_type: string }
interface CreateMeetingResponse { id: number | string; join_url: string; start_url: string }

/** Zoom's `start_time` for a scheduled meeting: UTC, seconds, `Z`, no millis. */
export function zoomStartTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Zoom, through a Server-to-Server OAuth app: `ZOOM_ACCOUNT_ID`,
 * `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`. The app needs the scopes
 * `meeting:write:meeting:admin`, `meeting:read:meeting:admin`,
 * `meeting:update:meeting:admin` and `meeting:delete:meeting:admin` (Zoom's
 * granular scopes; the classic `meeting:write:admin` no longer exists). Tokens
 * come from `POST /oauth/token?grant_type=account_credentials&account_id=…`
 * with Basic `client:secret`, last an hour and are cached until a minute
 * before expiry. Meetings are created under `users/me` — the app's owner —
 * which is Shoji's account; `hostEmail` is carried as informational only.
 */
export class ZoomMeetingsAdapter implements MeetingsAdapter {
  readonly name = "zoom" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly tokenEndpoint: string;
  private readonly apiBase: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ZoomMeetingsConfig, options: ZoomMeetingsOptions = {}) {
    if (!config.accountId || !config.clientId || !config.clientSecret) {
      throw new Error("ZoomMeetingsAdapter needs ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET");
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? ZOOM_DEFAULT_TIMEOUT_MS;
    this.tokenEndpoint = options.tokenEndpoint ?? ZOOM_TOKEN_ENDPOINT;
    this.apiBase = (options.apiBase ?? ZOOM_API_BASE).replace(/\/$/, "");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) return this.token.value;
    const url = `${this.tokenEndpoint}?grant_type=account_credentials&account_id=${encodeURIComponent(this.config.accountId)}`;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.request(url, { method: "POST", headers: { authorization: `Basic ${basic}` } });
    if (!res.ok) throw await this.classify(res, "Zoom refused the account credentials");
    const body = (await res.json()) as TokenResponse;
    if (!body.access_token) throw new MeetingsApiError("auth", "Zoom returned no access token");
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new MeetingsApiError("timeout", `Zoom did not answer within ${this.timeoutMs} ms`);
      }
      throw new MeetingsApiError("request_failed", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private async classify(res: Response, context: string): Promise<MeetingsApiError> {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string; reason?: string };
      detail = body.message ?? body.reason ?? "";
    } catch {
      // A non-JSON error body carries nothing worth quoting.
    }
    const message = `${context} (HTTP ${res.status}${detail ? `: ${detail}` : ""})`;
    if (res.status === 401 || res.status === 403) return new MeetingsApiError("auth", message, res.status);
    if (res.status === 404) return new MeetingsApiError("not_found", message, res.status);
    if (res.status === 429) return new MeetingsApiError("rate_limit", message, res.status);
    return new MeetingsApiError("request_failed", message, res.status);
  }

  private async api(path: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>): Promise<Response> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const init: RequestInit = body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
    return this.request(`${this.apiBase}${path}`, init);
  }

  async createMeeting(input: CreateMeetingInput): Promise<ProviderMeeting> {
    const res = await this.api("/users/me/meetings", "POST", {
      topic: input.topic.slice(0, 200),
      type: 2,
      start_time: zoomStartTime(input.startsAt),
      duration: input.durationMinutes,
      timezone: input.timezone,
      ...(input.agenda ? { agenda: input.agenda.slice(0, 2000) } : {}),
      settings: ZOOM_MEETING_SETTINGS,
    });
    if (!res.ok) throw await this.classify(res, "Zoom could not create the meeting");
    const body = (await res.json()) as CreateMeetingResponse;
    if (!body.join_url || body.id === undefined) throw new MeetingsApiError("request_failed", "Zoom created a meeting without a join URL");
    return { providerMeetingId: String(body.id), joinUrl: body.join_url, hostUrl: body.start_url ?? body.join_url };
  }

  async updateMeeting(providerMeetingId: string, input: UpdateMeetingInput): Promise<void> {
    const res = await this.api(`/meetings/${encodeURIComponent(providerMeetingId)}`, "PATCH", {
      start_time: zoomStartTime(input.startsAt), duration: input.durationMinutes,
    });
    if (!res.ok) throw await this.classify(res, "Zoom could not move the meeting");
  }

  async deleteMeeting(providerMeetingId: string): Promise<void> {
    const res = await this.api(`/meetings/${encodeURIComponent(providerMeetingId)}`, "DELETE");
    // Already gone is the outcome we wanted.
    if (res.status === 404) return;
    if (!res.ok) throw await this.classify(res, "Zoom could not delete the meeting");
  }
}
