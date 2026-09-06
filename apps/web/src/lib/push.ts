import { z } from "zod";

/**
 * Web push helpers shared by the browser (`device-alerts.tsx`) and the
 * subscribe route. Pure and dependency-free so the client bundle carries
 * nothing it does not need.
 */

/** The path the service worker is served from; `public/sw.js`. */
export const SERVICE_WORKER_PATH = "/sw.js";

/** The route the account page posts a subscription to. */
export const PUSH_SUBSCRIBE_PATH = "/api/push/subscribe";

/**
 * What the browser sends after `pushManager.subscribe`: the shape of
 * `PushSubscription.toJSON()`, narrowed to the three values the worker needs
 * to encrypt a message for this device.
 */
export const PushSubscriptionBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;

/** What the browser sends to take a device off the list: its endpoint only. */
export const PushUnsubscribeBody = z.object({ endpoint: z.string().url().max(2000) });
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBody>;

/**
 * A VAPID public key as `web-push` prints it (URL-safe base64, no padding)
 * turned into the bytes `pushManager.subscribe` wants for
 * `applicationServerKey`. Throws on a key that is not base64 at all, so a
 * mistyped environment variable fails on the button rather than as a silent
 * subscription to nowhere.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const trimmed = base64Url.trim();
  if (trimmed.length === 0) throw new Error("VAPID public key is empty");
  const padding = "=".repeat((4 - (trimmed.length % 4)) % 4);
  const base64 = (trimmed + padding).replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) throw new Error("VAPID public key is not base64");
  const raw = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * `PushSubscription.toJSON()` is typed loosely by the DOM lib (`keys` is an
 * optional record); this narrows it to the body the route accepts, or null
 * when the browser handed back a subscription without keys (which no current
 * browser does, but the type allows).
 */
export function subscriptionBody(json: { endpoint?: string | undefined; keys?: Record<string, string> | undefined }): PushSubscriptionBody | null {
  const parsed = PushSubscriptionBody.safeParse({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.["p256dh"], auth: json.keys?.["auth"] },
  });
  return parsed.success ? parsed.data : null;
}

/** The host of a push endpoint, for a device list that never shows the whole URL. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown push service";
  }
}
