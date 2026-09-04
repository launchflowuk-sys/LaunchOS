/**
 * The queue topology — names and dedupe policies — in the one place both
 * processes read it.
 *
 * The worker (`apps/worker/src/boss.ts`) and the web app
 * (`apps/web/src/lib/queue.ts`) both create queues, and whichever process
 * boots first wins: pg-boss's `create_queue` is `ON CONFLICT DO NOTHING`, so a
 * queue created without a policy by one process can never be corrected by the
 * other. Both therefore go through `ensureQueues` below, which creates and
 * then converges the policy of every queue in this table.
 *
 * This module holds data and a structurally typed applier only — `core` still
 * imports nothing from pg-boss (see CLAUDE.md's dependency direction).
 *
 * ## What `singletonKey` actually guarantees
 *
 * A `singletonKey` on `send` is inert on its own: pg-boss enforces dedupe
 * purely through partial unique indexes on `job`, and under the default
 * `standard` policy none of them apply, so every send inserts a new row.
 * (pg-boss 10.4.2, `src/plans.js` — `job_i1` covers `policy = 'short'`,
 * `job_i2` `'singleton'`, `job_i3` `'stately'`, and `job_i4` only rows where
 * `singleton_on` is set, which happens only when the send passes
 * `singletonSeconds`.)
 *
 * So the guarantee is bought two ways, and both are used here:
 *
 * 1. **Queue policy `stately`** — at most one job per `(queue, singletonKey)`
 *    in each of the `created`, `retry` and `active` states. A duplicate send
 *    while the first is still queued or running collapses. Given to every
 *    queue where *every* send carries a key. Not given to `domain.event`,
 *    whose sends carry no key at all: `COALESCE(singleton_key, '')` would
 *    collapse every unrelated event into one job.
 * 2. **`singletonSeconds` on the send** — a time window that also covers
 *    already-completed jobs, so a retried fan-out cannot re-run work that
 *    already succeeded. Used where a duplicate costs money or messages a
 *    client (the Sentinel fan-out and the Stripe webhook); see
 *    `DEDUPE_WINDOW_SECONDS`.
 *
 * Anything beyond those two is enforced at the domain layer (e.g. the unique
 * `(organisation_id, provider, provider_ref)` index behind
 * `syncFromPaymentsEvent`), not by the queue.
 */

export type QueuePolicy = "standard" | "short" | "singleton" | "stately";

/** Every queue name in the system. Both processes address queues through this. */
export const QUEUE = {
  monitorCheck: "monitor.check",
  agentRun: "agent.run",
  agentResume: "agent.resume",
  inboundMessage: "inbound.message",
  outboundMessage: "outbound.message",
  domainEvent: "domain.event",
  tasksGenerateOnboarding: "tasks.generate-onboarding",
  tasksGenerateRecurring: "tasks.generate-recurring",
  tasksCheckOverdue: "tasks.check-overdue",
  paymentsWebhook: "payments.webhook",
  adsIngest: "ads.ingest",
  adsSentinel: "ads.sentinel",
  invoicesOverdue: "invoices.check-overdue",
  reportsMonthly: "reports.monthly",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * `stately` wherever every send to the queue carries a `singletonKey`;
 * `standard` for the cron queues (payload `{}`, no key, one job per tick is
 * the point) and for `domain.event`, whose sends carry no key.
 */
export const QUEUE_POLICY: Readonly<Record<QueueName, QueuePolicy>> = {
  "monitor.check": "standard",
  "agent.run": "stately",
  "agent.resume": "stately",
  "inbound.message": "stately",
  "outbound.message": "stately",
  "domain.event": "standard",
  "tasks.generate-onboarding": "stately",
  "tasks.generate-recurring": "standard",
  "tasks.check-overdue": "standard",
  "payments.webhook": "stately",
  "ads.ingest": "standard",
  "ads.sentinel": "standard",
  "invoices.check-overdue": "standard",
  "reports.monthly": "standard",
};

export interface QueueSpec {
  readonly name: QueueName;
  readonly policy: QueuePolicy;
}

export const QUEUE_SPECS: readonly QueueSpec[] = Object.values(QUEUE).map((name) => ({
  name,
  policy: QUEUE_POLICY[name],
}));

/**
 * One day, in seconds. Paired with `singletonKey` on the sends whose
 * duplicates cost real money or reach a client — a Sentinel agent run and a
 * Stripe event. `singleton_on` buckets on the epoch, so this reads as "once
 * per key per UTC day" rather than "once per rolling 24 hours".
 */
export const DEDUPE_WINDOW_SECONDS = 86_400;

/** The dedupe options for a send that must not repeat within a day. */
export function dailyDedupe(key: string): { singletonKey: string; singletonSeconds: number } {
  return { singletonKey: key, singletonSeconds: DEDUPE_WINDOW_SECONDS };
}

/**
 * The slice of pg-boss this module needs. Structural, so `core` does not have
 * to import pg-boss to describe it — a `PgBoss` instance satisfies it.
 */
export interface QueueAdmin {
  createQueue(name: string, options?: { name: string; policy?: QueuePolicy }): Promise<void>;
  updateQueue(name: string, options?: { name: string; policy?: QueuePolicy }): Promise<void>;
}

/**
 * Creates every queue with its policy, then updates it to the same policy.
 *
 * The update is not redundant: `create_queue` ignores conflicts, so a queue
 * that already exists (every deploy after the first, and every local database
 * created before this table did) keeps whatever policy it was first created
 * with. The update is what actually converges an existing deployment. Only
 * `policy` is sent, so queue-level retry/expiry settings are left untouched
 * (the SQL COALESCEs each column against its current value).
 */
export async function ensureQueues(boss: QueueAdmin): Promise<void> {
  for (const spec of QUEUE_SPECS) {
    const options = { name: spec.name, policy: spec.policy };
    await boss.createQueue(spec.name, options);
    await boss.updateQueue(spec.name, options);
  }
}
