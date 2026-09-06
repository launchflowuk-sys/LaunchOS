import {
  PushPayloadSchema, PushSubscriptionSchema, isPushGoneStatus,
  type PushAdapter, type PushDelivery, type PushPayload, type PushSubscriptionInput,
} from "./types.js";

export interface MockPushSend {
  readonly subscription: PushSubscriptionInput;
  readonly payload: PushPayload;
}

/**
 * Records what it was asked to send instead of contacting a push service,
 * and can be told to answer a given endpoint with a status code — `410` to
 * play a browser that unsubscribed, `500` for a service having a bad day —
 * so the worker's handling of each outcome is testable without a browser.
 */
export class MockPushAdapter implements PushAdapter {
  readonly name = "mock" as const;
  readonly sent: MockPushSend[] = [];
  private readonly failures = new Map<string, number>();

  /** Every later send to `endpoint` answers with `statusCode` instead of succeeding. */
  failEndpoint(endpoint: string, statusCode: number): void {
    this.failures.set(endpoint, statusCode);
  }

  /** Back to delivering for `endpoint`. */
  restoreEndpoint(endpoint: string): void {
    this.failures.delete(endpoint);
  }

  async send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushDelivery> {
    const sub = PushSubscriptionSchema.parse(subscription);
    const body = PushPayloadSchema.parse(payload);
    const statusCode = this.failures.get(sub.endpoint);
    if (statusCode === undefined) {
      this.sent.push({ subscription: sub, payload: body });
      return { outcome: "sent", statusCode: 201 };
    }
    const error = `mock push service answered ${statusCode}`;
    if (isPushGoneStatus(statusCode)) return { outcome: "gone", statusCode, error };
    return { outcome: "failed", statusCode, error };
  }
}
