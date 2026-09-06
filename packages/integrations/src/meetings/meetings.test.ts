import { describe, expect, it, vi } from "vitest";
import { describeAdapters, productionAdapterIssues, productionMockWarnings, resolveAdapters } from "../adapter-guard.js";
import { createIntegrations } from "../index.js";
import { MockMeetingsAdapter, ZOOM_ENV_KEYS, createMeetingsAdapterFromEnv } from "./index.js";
import { MeetingsApiError } from "./types.js";
import { ZOOM_MEETING_SETTINGS, ZoomMeetingsAdapter, zoomStartTime } from "./zoom.js";

const config = { accountId: "acc_1", clientId: "cid", clientSecret: "secret" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ZoomMeetingsAdapter", () => {
  it("fetches an account-credentials token with Basic auth once, then creates a meeting under users/me with our settings", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).startsWith("https://zoom.us/oauth/token")) return json(200, { access_token: "tok", expires_in: 3600, token_type: "bearer" });
      if (String(url).endsWith("/users/me/meetings")) return json(201, { id: 91234567890, join_url: "https://zoom.us/j/91234567890", start_url: "https://zoom.us/s/91234567890?zak=x" });
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json(500, {});
    });
    const zoom = new ZoomMeetingsAdapter(config, { fetch: fetchImpl as unknown as typeof fetch, now: () => 1_000_000 });
    const startsAt = new Date("2026-09-08T12:00:00.123Z");
    const created = await zoom.createMeeting({ topic: "LaunchFlow discovery call with Aisha", startsAt, durationMinutes: 30, timezone: "Europe/London", hostEmail: "shoji@launchflow.test", agenda: "SEO" });
    expect(created).toEqual({ providerMeetingId: "91234567890", joinUrl: "https://zoom.us/j/91234567890", hostUrl: "https://zoom.us/s/91234567890?zak=x" });

    expect(calls[0]!.url).toBe("https://zoom.us/oauth/token?grant_type=account_credentials&account_id=acc_1");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    expect(calls[1]!.url).toBe("https://api.zoom.us/v2/users/me/meetings");
    expect((calls[1]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      topic: "LaunchFlow discovery call with Aisha", type: 2, start_time: "2026-09-08T12:00:00Z", duration: 30, timezone: "Europe/London", agenda: "SEO",
      settings: { join_before_host: false, waiting_room: true, auto_recording: "cloud" },
    });
    expect(ZOOM_MEETING_SETTINGS.waiting_room).toBe(true);

    await zoom.updateMeeting("91234567890", { startsAt: new Date("2026-09-09T12:00:00Z"), durationMinutes: 30 });
    await zoom.deleteMeeting("91234567890");
    // The token was fetched once for the three API calls.
    expect(calls.filter((c) => c.url.startsWith("https://zoom.us/oauth/token"))).toHaveLength(1);
    expect(calls[2]!.url).toBe("https://api.zoom.us/v2/meetings/91234567890");
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ start_time: "2026-09-09T12:00:00Z", duration: 30 });
    expect(calls[3]!.init.method).toBe("DELETE");
    expect(zoomStartTime(startsAt)).toBe("2026-09-08T12:00:00Z");
  });

  it("refreshes an expiring token, classifies refusals, tolerates a delete of a meeting already gone, and times out", async () => {
    let clock = 0;
    let tokens = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://zoom.us/oauth/token")) { tokens++; return json(200, { access_token: `tok${tokens}`, expires_in: 120 }); }
      if (init?.method === "DELETE") return json(404, { code: 3001, message: "Meeting does not exist" });
      if (init?.method === "PATCH") return json(401, { message: "Invalid access token." });
      if (u.endsWith("/users/me/meetings")) return json(429, { message: "too many" });
      return json(500, {});
    });
    const zoom = new ZoomMeetingsAdapter(config, { fetch: fetchImpl as unknown as typeof fetch, now: () => clock });
    await zoom.deleteMeeting("1"); // 404 → fine
    expect(tokens).toBe(1);
    clock = 70_000; // 120 s token, refreshed a minute early → a new one at 70 s
    await zoom.deleteMeeting("2");
    expect(tokens).toBe(2);
    await expect(zoom.updateMeeting("1", { startsAt: new Date(), durationMinutes: 30 })).rejects.toMatchObject({ kind: "auth", status: 401 });
    await expect(zoom.createMeeting({ topic: "t", startsAt: new Date(), durationMinutes: 30, timezone: "Europe/London", hostEmail: "h@t.test" }))
      .rejects.toMatchObject({ kind: "rate_limit", status: 429 });

    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const slow = new ZoomMeetingsAdapter(config, { fetch: hanging as unknown as typeof fetch, timeoutMs: 10 });
    await expect(slow.deleteMeeting("1")).rejects.toMatchObject({ kind: "timeout" });
    expect(() => new ZoomMeetingsAdapter({ accountId: "", clientId: "c", clientSecret: "s" })).toThrow(/ZOOM_ACCOUNT_ID/);
    expect(new MeetingsApiError("auth", "x").name).toBe("MeetingsApiError");
  });
});

describe("mock adapter and selection", () => {
  it("mints mock ids and example URLs, records every call, and can fail the next create on demand", async () => {
    const mock = new MockMeetingsAdapter();
    const m = await mock.createMeeting({ topic: "t", startsAt: new Date(), durationMinutes: 30, timezone: "Europe/London", hostEmail: "h@t.test" });
    expect(m.providerMeetingId).toMatch(/^mock_/);
    expect(m.joinUrl).toMatch(/^https:\/\/meet\.launchflow\.example\/j\//);
    await mock.updateMeeting(m.providerMeetingId, { startsAt: new Date(), durationMinutes: 30 });
    await mock.deleteMeeting(m.providerMeetingId);
    expect(mock.created).toHaveLength(1);
    expect(mock.updated[0]!.providerMeetingId).toBe(m.providerMeetingId);
    expect(mock.deleted).toEqual([m.providerMeetingId]);
    mock.failNextCreate = new Error("boom");
    await expect(mock.createMeeting({ topic: "t", startsAt: new Date(), durationMinutes: 30, timezone: "Europe/London", hostEmail: "h@t.test" })).rejects.toThrow("boom");
  });

  it("selects Zoom only with all three keys; the guard names a partial set and warns on the mock in production", () => {
    expect(createMeetingsAdapterFromEnv({}).name).toBe("mock");
    expect(createMeetingsAdapterFromEnv({ ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b" }).name).toBe("mock");
    expect(createMeetingsAdapterFromEnv({ ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b", ZOOM_CLIENT_SECRET: " " }).name).toBe("mock");
    expect(createMeetingsAdapterFromEnv({ ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b", ZOOM_CLIENT_SECRET: "c" }).name).toBe("zoom");
    expect(createIntegrations({}).meetings.name).toBe("mock");
    expect(ZOOM_ENV_KEYS).toEqual(["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"]);

    expect(describeAdapters({})["meetings"]).toBe("mock");
    expect(describeAdapters({ ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b", ZOOM_CLIENT_SECRET: "c" })["meetings"]).toBe("zoom");
    const row = resolveAdapters({})!.find((a) => a.name === "meetings")!;
    expect(row).toMatchObject({ variable: "ZOOM_ACCOUNT_ID,ZOOM_CLIENT_ID,ZOOM_CLIENT_SECRET", mockWhenUnset: "log", requested: "mock", resolved: "mock" });

    const live = { NODE_ENV: "production", EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", UPTIME_PROBE: "http", PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh" };
    expect(productionAdapterIssues(live).filter((i) => i.variable.startsWith("ZOOM"))).toEqual([]);
    expect(productionMockWarnings(live).find((w) => w.variable.startsWith("ZOOM"))?.message).toMatch(/meetings adapter is the MOCK/);
    const partial = productionAdapterIssues({ ...live, ZOOM_ACCOUNT_ID: "a" }).find((i) => i.variable.startsWith("ZOOM"));
    expect(partial?.message).toMatch(/Missing: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET/);
    expect(productionAdapterIssues({ ...live, ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b", ZOOM_CLIENT_SECRET: "c" }).filter((i) => i.variable.startsWith("ZOOM"))).toEqual([]);
  });
});
