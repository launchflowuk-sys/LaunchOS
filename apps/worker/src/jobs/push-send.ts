import { appUrl, getNotification, listPushSubscriptions, recordPushDelivery } from "@launchos/core";
import type { PushAdapter, PushPayload } from "@launchos/channels";
import type { Db } from "@launchos/db";

/** The `push.send` payload: one notification for one user, fanned out here to their devices. */
export interface PushSendJob {
  organisationId: string;
  notificationId: string;
  userId: string;
}

export interface PushSendDeps {
  readonly db: Db;
  readonly push: PushAdapter;
  /** `APP_URL`, for turning a notification's relative link into the absolute one a tap opens. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Pick<Console, "info" | "warn">;
  /**
   * `notify()` can run inside a caller's transaction and emit before it
   * commits, so the first read here may not see the row yet. A couple of
   * short re-reads cover that without failing the job; a row still missing
   * after them rolled back, and there is nothing to send.
   */
  readonly readAttempts?: number;
  readonly readDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PushSendResult {
  outcome: "no_notification" | "no_subscriptions" | "delivered";
  sent: number;
  failed: number;
  /** Subscriptions the push service no longer knows; removed. */
  gone: number;
}

const DEFAULT_READ_ATTEMPTS = 3;
const DEFAULT_READ_DELAY_MS = 750;
/** `recordPushDelivery` keeps at most this much of the push service's reply. */
const MAX_DELIVERY_ERROR_CHARS = 500;

/** The tag one notification carries on every device, so a retried job replaces rather than stacks. */
export function pushTagFor(notificationId: string): string {
  return `launchos:${notificationId}`;
}

/** The notification as a push payload; the link becomes absolute so the service worker can open it. */
export function pushPayloadFor(
  notification: { id: string; title: string; body: string | null; link: string | null },
  env: NodeJS.ProcessEnv = process.env,
): PushPayload {
  const base = appUrl(env);
  const url = notification.link === null ? base : notification.link.startsWith("/") ? `${base}${notification.link}` : notification.link;
  return { title: notification.title, body: notification.body ?? "", url, tag: pushTagFor(notification.id) };
}

async function readNotification(deps: PushSendDeps, job: PushSendJob) {
  const attempts = Math.max(1, deps.readAttempts ?? DEFAULT_READ_ATTEMPTS);
  const delay = deps.readDelayMs ?? DEFAULT_READ_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    const row = await getNotification(deps.db, job.organisationId, job.notificationId);
    if (row !== null || attempt >= attempts) return row;
    await sleep(delay);
  }
}

/**
 * Sends one notification to every device the user has subscribed, records
 * each outcome, and never throws for a dead endpoint: a 404/410 removes the
 * subscription (`gone`), anything else stamps `failed_at` and the next alert
 * tries that device again. A job that throws would be retried by pg-boss —
 * and the devices that did receive the alert would receive it again.
 */
export async function handlePushSend(deps: PushSendDeps, job: PushSendJob): Promise<PushSendResult> {
  const logger = deps.logger ?? console;
  const notification = await readNotification(deps, job);
  if (notification === null) {
    logger.warn({ organisationId: job.organisationId, notificationId: job.notificationId }, "push.send: notification not found; nothing to send");
    return { outcome: "no_notification", sent: 0, failed: 0, gone: 0 };
  }
  if (notification.userId !== job.userId) {
    logger.warn({ notificationId: job.notificationId }, "push.send: job user does not match the notification; nothing sent");
    return { outcome: "no_notification", sent: 0, failed: 0, gone: 0 };
  }

  const subscriptions = await listPushSubscriptions(deps.db, job.organisationId, { userId: job.userId });
  if (subscriptions.length === 0) return { outcome: "no_subscriptions", sent: 0, failed: 0, gone: 0 };

  const payload = pushPayloadFor(notification, deps.env);
  let sent = 0;
  let failed = 0;
  let gone = 0;
  for (const subscription of subscriptions) {
    const delivery = await deps.push.send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload);
    if (delivery.outcome === "sent") {
      sent += 1;
      await recordPushDelivery(deps.db, job.organisationId, { subscriptionId: subscription.id, outcome: "sent" });
      continue;
    }
    if (delivery.outcome === "gone") gone += 1;
    else failed += 1;
    await recordPushDelivery(deps.db, job.organisationId, {
      subscriptionId: subscription.id, outcome: delivery.outcome, error: delivery.error.slice(0, MAX_DELIVERY_ERROR_CHARS),
    });
    logger.warn(
      { notificationId: notification.id, subscriptionId: subscription.id, outcome: delivery.outcome, statusCode: delivery.statusCode ?? null },
      `push.send: ${delivery.outcome}: ${delivery.error}`,
    );
  }
  const result: PushSendResult = { outcome: "delivered", sent, failed, gone };
  logger.info({ notificationId: notification.id, kind: notification.kind, ...result }, "push.send");
  return result;
}
