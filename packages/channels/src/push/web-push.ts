import webpush, { type RequestOptions, type SendResult } from "web-push";
import {
  PushPayloadSchema, PushSubscriptionSchema, isPushGoneStatus,
  type PushAdapter, type PushDelivery, type PushPayload, type PushSubscriptionInput,
} from "./types.js";

/** How long a push service holds an undelivered alert for a phone that is off. An hour: after that it is stale. */
export const PUSH_TTL_SECONDS = 60 * 60;

export interface VapidDetails {
  /** A `mailto:` address or an `https:` URL the push service can contact about abuse. */
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** The one call this adapter makes, injectable so tests never open a socket. */
export type SendNotificationFn = (
  subscription: PushSubscriptionInput,
  payload: string,
  options: RequestOptions,
) => Promise<SendResult>;

export interface WebPushAdapterOptions {
  readonly vapid: VapidDetails;
  readonly sendNotification?: SendNotificationFn;
}

const VAPID_SUBJECT_PATTERN = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/;

/** The web push standard: a VAPID subject is `mailto:` or `https:`. Named here so the factory refuses a bare address at boot. */
export function isValidVapidSubject(subject: string): boolean {
  return VAPID_SUBJECT_PATTERN.test(subject.trim());
}

/** The status the push service answered, from the error `web-push` throws (`WebPushError` carries one; a network failure does not). */
function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code = (error as { statusCode: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Real web push through the `web-push` package: the payload is encrypted to
 * the subscription's keys and signed with our VAPID key pair, so the push
 * service (Google, Apple, Mozilla) delivers it without being able to read it.
 *
 * The VAPID details travel per call rather than through `setVapidDetails`,
 * which is process-global state a second adapter in the same process would
 * overwrite. A response is turned into a `PushDelivery` rather than thrown:
 * 404 and 410 mean the subscription is dead (`gone`) and the worker removes
 * it; anything else is `failed` and the next alert tries again.
 */
export class WebPushAdapter implements PushAdapter {
  readonly name = "web-push" as const;
  private readonly vapid: VapidDetails;
  private readonly sendNotification: SendNotificationFn;

  constructor(options: WebPushAdapterOptions) {
    if (!options.vapid.publicKey || !options.vapid.privateKey) {
      throw new Error("WebPushAdapter: VAPID public and private keys are required");
    }
    if (!isValidVapidSubject(options.vapid.subject)) {
      throw new Error("WebPushAdapter: VAPID subject must be a mailto: address or an https: URL");
    }
    this.vapid = { ...options.vapid, subject: options.vapid.subject.trim() };
    this.sendNotification = options.sendNotification
      ?? ((subscription, payload, requestOptions) => webpush.sendNotification(subscription, payload, requestOptions));
  }

  async send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushDelivery> {
    const sub = PushSubscriptionSchema.parse(subscription);
    const body = PushPayloadSchema.parse(payload);
    try {
      const result = await this.sendNotification(sub, JSON.stringify(body), {
        vapidDetails: this.vapid,
        TTL: PUSH_TTL_SECONDS,
        urgency: "high",
      });
      return { outcome: "sent", statusCode: result.statusCode };
    } catch (error) {
      const statusCode = statusOf(error);
      const message = messageOf(error);
      if (isPushGoneStatus(statusCode)) return { outcome: "gone", statusCode, error: message };
      return statusCode === undefined ? { outcome: "failed", error: message } : { outcome: "failed", statusCode, error: message };
    }
  }
}
