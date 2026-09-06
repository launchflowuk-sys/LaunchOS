import { z } from "zod";

/**
 * A browser's push subscription, exactly as `PushSubscription.toJSON()` hands
 * it over and as `push_subscriptions` stores it: the push service endpoint
 * and the two client keys the payload is encrypted to.
 */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionSchema>;

/**
 * What the service worker shows. `url` is where a tap opens; `tag` collapses
 * a repeat of the same notification on the device rather than stacking it.
 */
export const PushPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(1000),
  url: z.string().url().max(2000).optional(),
  tag: z.string().min(1).max(100).optional(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/**
 * The three things a push service can say back, as data rather than throws:
 * the worker's `push.send` job maps them one-to-one onto
 * `recordPushDelivery` (`sent` / `failed` / `gone`). `gone` is a 404 or 410 —
 * the browser unsubscribed, or the subscription expired — and means the row
 * should be removed; anything else is worth another try from the next alert.
 */
export type PushDelivery =
  | { outcome: "sent"; statusCode: number }
  | { outcome: "gone"; statusCode: number; error: string }
  | { outcome: "failed"; statusCode?: number; error: string };

export interface PushAdapter {
  readonly name: "mock" | "web-push";
  /** Never throws for a push-service response; only for a malformed subscription or payload. */
  send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushDelivery>;
}

/** The statuses that mean "this subscription will never deliver again". */
export const PUSH_GONE_STATUSES: readonly number[] = [404, 410];

export function isPushGoneStatus(statusCode: number | undefined): statusCode is number {
  return statusCode !== undefined && PUSH_GONE_STATUSES.includes(statusCode);
}
