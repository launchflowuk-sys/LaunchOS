import { MockMeetingsAdapter } from "./mock.js";
import { ZoomMeetingsAdapter } from "./zoom.js";
import type { MeetingsAdapter } from "./types.js";

export * from "./types.js";
export { MockMeetingsAdapter } from "./mock.js";
export { ZoomMeetingsAdapter, ZOOM_MEETING_SETTINGS, ZOOM_TOKEN_ENDPOINT, ZOOM_API_BASE, zoomStartTime } from "./zoom.js";
export type { ZoomMeetingsConfig, ZoomMeetingsOptions } from "./zoom.js";

/** The three keys that select Zoom. All three or nothing; `adapter-guard.ts` names a partial set. */
export const ZOOM_ENV_KEYS = ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"] as const;

function trimmedOrUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Zoom when all three `ZOOM_*` keys are set, the mock otherwise. Constructs
 * only — no token is fetched until the first booking — so a wrong secret
 * fails at the first `createMeeting`, loudly, rather than at boot.
 */
export function createMeetingsAdapterFromEnv(env: NodeJS.ProcessEnv): MeetingsAdapter {
  const accountId = trimmedOrUnset(env.ZOOM_ACCOUNT_ID);
  const clientId = trimmedOrUnset(env.ZOOM_CLIENT_ID);
  const clientSecret = trimmedOrUnset(env.ZOOM_CLIENT_SECRET);
  if (accountId && clientId && clientSecret) return new ZoomMeetingsAdapter({ accountId, clientId, clientSecret });
  return new MockMeetingsAdapter();
}
