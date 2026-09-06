/**
 * The notification kinds that should wake a phone, not just light the bell.
 *
 * Everything else — a task assigned, a client suggestion, a report built —
 * waits until somebody opens the portal. `approval.requested` is here because
 * an approval is work only a human can do and the agents are parked until it
 * is decided; the one exception is a content post (`content_publish`), which
 * arrives in batches of seven at a time and is deliberately left to the bell.
 * Callers that raise a content-publish approval should use a different kind
 * (`content_item.approval_requested`, as the content engine already does).
 */
export const URGENT_NOTIFICATION_KINDS = [
  "incident.opened",
  "payment.failed",
  "invoice.overdue",
  "case.sla_breached",
  "agent.gave_up",
  "send.failed",
  "approval.requested",
  "worker.down",
  "system.error",
  "lead.created",
  // A call somebody just booked, and a call starting in fifteen minutes —
  // both are the phone's business, not the bell's.
  "meeting.booked",
  "meeting.starting",
] as const;

export type UrgentNotificationKind = (typeof URGENT_NOTIFICATION_KINDS)[number];

/**
 * Whether a notification of this kind is pushed to the user's devices.
 *
 * The explicit list above, plus the `<thing>.send_failed` family the codebase
 * already raises (`message.send_failed`, `invoice.send_failed`,
 * `ad_report.send_failed`) — each one is an email a client was promised and
 * did not get, which is exactly the spec's `send.failed`.
 */
export function pushForNotification(kind: string): boolean {
  return (URGENT_NOTIFICATION_KINDS as readonly string[]).includes(kind) || kind.endsWith(".send_failed");
}
