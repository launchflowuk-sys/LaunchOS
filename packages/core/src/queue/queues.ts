/**
 * The queue topology — names, dedupe policies and retry settings — in the one
 * place both processes read it.
 *
 * The worker (`apps/worker/src/boss.ts`) and the web app
 * (`apps/web/src/lib/queue.ts`) both create queues, and whichever process
 * boots first wins: pg-boss's `create_queue` is `ON CONFLICT DO NOTHING`, so a
 * queue created without a policy by one process can never be corrected by the
 * other. Both therefore go through `ensureQueues` below, which creates and
 * then converges every queue in this table.
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
 * 1. **Queue policy `short`** — `job_i1` is
 *    `UNIQUE (name, COALESCE(singleton_key, '')) WHERE state = 'created'`.
 *    The exact guarantee is therefore: **a duplicate is collapsed only while
 *    the first job is still queued.** Once the first job starts running the
 *    key is free again, and nothing stronger is claimed. Given to every queue
 *    where *every* send carries a key. Not given to `domain.event`, whose
 *    sends carry no key at all: `COALESCE(singleton_key, '')` would collapse
 *    every unrelated event into one job.
 *
 *    `stately` was tried and reverted. Its index is
 *    `UNIQUE (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active'`,
 *    which constrains `created`, `retry` and `active` *separately*. A send
 *    arriving while the first job is `active` therefore inserts a second
 *    `created` row quite legally, and pg-boss's `fetchNextJob` — whose only
 *    singleton guard is a `row_number()` partition within one fetched batch,
 *    and which does not even apply that at the default `batchSize` of 1 —
 *    then tries to promote it to `active` and violates `job_i3`. The whole
 *    `UPDATE` aborts, and `manager.fetch` swallows the error on purpose
 *    ("errors from fetchquery should only be unique constraint violations",
 *    `manager.js:442-448`), so the fetch returns an empty array: **no job is
 *    fetched and nothing is logged.** Because the fetch orders by `created_on`
 *    and takes `LIMIT 1`, that stuck row is the head of the queue, so nothing
 *    behind it moves either — for every tenant — until the active job ends.
 *    Measured against pg-boss 10.4.2 on Postgres 17: under `stately` the
 *    second fetch returns 0 rows and the job stays `created`; under `short`
 *    both jobs are fetched.
 *
 *    Two paths here produce that without any failure at all: a second press of
 *    Approve while `agent.resume` is running, and a retried `domain.event`
 *    re-sending `tasks.generate-onboarding`. `short` cannot abort a fetch: its
 *    index covers only `created`, and the fetch's `UPDATE` moves rows *out* of
 *    `created`.
 *
 * 2. **`singletonSeconds` on the send** — a time window that also covers
 *    already-completed *and failed* jobs, so a retried fan-out cannot re-run
 *    work that already succeeded. Reserved for the one send where a duplicate
 *    costs real money and there is no domain-level equivalent: the Ad
 *    Performance Sentinel fan-out (`ad-sentinel:<org>:<yyyy-mm-dd>`); see
 *    `DEDUPE_WINDOW_SECONDS` and the caveat on `dailyDedupe`.
 *
 *    It is deliberately *not* used on `payments.webhook`. `job_i4` covers
 *    `failed`, so a window there would mean a Stripe event whose sync failed
 *    could not be re-delivered for the rest of the UTC day — silently, since
 *    a dropped insert just returns a null job id. Stripe redelivery is the
 *    only recovery path a failed payment sync has. The duplicate protection
 *    that matters for payments is the domain layer's instead (below).
 *
 * Anything beyond those two is enforced at the domain layer (e.g. the unique
 * `(organisation_id, provider, provider_ref)` index behind
 * `syncFromPaymentsEvent`, which answers `{ handled: false, action:
 * "duplicate" }` with the row in front of it rather than dropping an insert).
 *
 * ## Key conventions per queue
 *
 * The keys are chosen at the send sites; they are listed here because this
 * module is the single source of truth for what a key buys.
 *
 * | Queue | Key | Sent from |
 * |---|---|---|
 * | `agent.run` | `guard-dog:<incidentId>` | `apps/worker/src/jobs/dispatch-event.ts` |
 * | `agent.run` | `support-triage:<ticketId>` | `apps/worker/src/jobs/dispatch-event.ts` |
 * | `agent.run` | `support-triage:<ticketId>:manual:<epochMs>` — timestamped **on purpose**, so an operator's "run now" is never deduped away | `apps/web/src/app/(admin)/cases/[id]/actions.ts` |
 * | `agent.run` | `ad-sentinel:<org>:<yyyy-mm-dd>` + `singletonSeconds` | `apps/worker/src/jobs/ads-sentinel.ts` |
 * | `agent.resume` | `resume:<approvalId>` | `dispatch-event.ts`, `apps/web/src/app/(admin)/approvals/actions.ts`, `apps/worker/src/jobs/resume-sweep.ts` |
 * | `inbound.message` | `inbound:<providerMessageId>` | `dispatch-event.ts`, `apps/web/src/lib/queue.ts` |
 * | `outbound.message` | `outbound:<messageId>` | `dispatch-event.ts`, `apps/web/src/lib/queue.ts`, `apps/worker/src/jobs/outbound-sweep.ts` |
 * | `tasks.generate-onboarding` | `onboarding:<clientId>` | `dispatch-event.ts` |
 * | `payments.webhook` | `stripe:<eventId>` | `apps/web/src/app/api/webhooks/stripe/route.ts`, `dispatch-event.ts` |
 * | `content.draft` | `content-draft:<clientId>:<periodKey>` + `singletonSeconds` (an Opus-priced writer run, like the Sentinel); a manual "Draft with AI" appends `:manual:<epochMs>` | `apps/worker/src/jobs/content-plan-month.ts`, C4's client content tab |
 * | `content.render-image` | `render-image:<itemId>` — no window; see the note under `QUEUE_POLICY` | `apps/worker/src/jobs/content-render-image.ts` (the publish-due backfill), the post editor and the approval card |
 * | `ops.brief` | none from the cron (payload `{}`); a manual "Write today's brief" sends `{ organisationId }` with `ops-brief:<org>:manual:<epochMs>` | `apps/worker/src/jobs/ops-brief.ts`, the web `/briefs` page |
 * | `push.send` | `push:<notificationId>` — one delivery per notification, fanned out to the user's devices by the job | `dispatch-event.ts` on the `push.requested` domain event `notify()` emits |
 * | `support.sla-sweep` | none — a 15-minute cron, payload `{}` | the worker's cron registration |
 * | `billing.stripe-reconcile` | none — a daily cron at 04:10 London, payload `{}` | the worker's cron registration |
 * | `billing.invoice-documents` | none — a two-minute cron, payload `{}` | the worker's cron registration |
 * | `meetings.remind` / `meetings.follow-up` | none — crons, payload `{}` | the worker's cron registration |
 * | `agent.run` | `lead-qualifier:<leadId>` | `dispatch-event.ts` on `lead.created` |
 * | `domain.event` | none — hence `standard` | `apps/web/src/lib/queue.ts` |
 * | `proposals.send` | `proposal-send:<proposalId>` from a decided approval and from the admin Send button; **none** from the two-minute tick, which is why the queue is `standard` | `apps/worker/src/jobs/proposals-send.ts`, the worker's cron, the approvals action |
 * | `proposals.accepted` | `proposal-accepted:<proposalId>` | `acceptProposal` through `setProposalFollowOn`, and the same file's safety net |
 * | `proposals.expire` / `proposals.nudge` | none — daily crons, payload `{}` | the worker's cron registration |
 * | `projects.weekly-update` | none — a Friday cron, payload `{}`; the fan-out it sends is an `agent.run` keyed `project-reporter:<projectId>:<yyyy-mm-dd>` under `dailyDedupe` | `apps/worker/src/jobs/project-weekly-update.ts` |
 * | `projects.milestone-email` | `milestone-email:<milestoneId>` | `dispatch-event.ts` on `project.milestone_reached` |
 * | `projects.delivered` | `project-delivered:<projectId>` | `dispatch-event.ts` on `project.delivered` |
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
  approvalsResumeSweep: "approvals.resume-sweep",
  agentRunsStuckSweep: "agent-runs.stuck-sweep",
  outboundSweep: "outbound.sweep",
  contentPlanMonth: "content.plan-month",
  contentDraft: "content.draft",
  contentPublishDue: "content.publish-due",
  contentRenderImage: "content.render-image",
  contentReport: "content.report",
  opsBrief: "ops.brief",
  pushSend: "push.send",
  supportSlaSweep: "support.sla-sweep",
  billingStripeReconcile: "billing.stripe-reconcile",
  billingInvoiceDocuments: "billing.invoice-documents",
  meetingsRemind: "meetings.remind",
  meetingsFollowUp: "meetings.follow-up",
  deliverySend: "delivery.send",
  proposalsSend: "proposals.send",
  proposalsAccepted: "proposals.accepted",
  proposalsExpire: "proposals.expire",
  proposalsNudge: "proposals.nudge",
  projectsWeeklyUpdate: "projects.weekly-update",
  projectsMilestoneEmail: "projects.milestone-email",
  projectsDelivered: "projects.delivered",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * `short` wherever every send to the queue carries a `singletonKey`;
 * `standard` for the cron queues (payload `{}`, no key, one job per tick is
 * the point) and for `domain.event`, whose sends carry no key.
 */
export const QUEUE_POLICY: Readonly<Record<QueueName, QueuePolicy>> = {
  "monitor.check": "standard",
  "agent.run": "short",
  "agent.resume": "short",
  "inbound.message": "short",
  "outbound.message": "short",
  "domain.event": "standard",
  "tasks.generate-onboarding": "short",
  "tasks.generate-recurring": "standard",
  "tasks.check-overdue": "standard",
  "payments.webhook": "short",
  "ads.ingest": "standard",
  "ads.sentinel": "standard",
  "invoices.check-overdue": "standard",
  "reports.monthly": "standard",
  // Cron queues: payload `{}`, no key, one job per tick is the point. The
  // `agent.resume` jobs the resume sweep *sends* are keyed `resume:<approvalId>`
  // onto the `short` queue above, which is what makes re-enqueueing an
  // already-queued resume a no-op rather than a second delivery.
  "approvals.resume-sweep": "standard",
  "agent-runs.stuck-sweep": "standard",
  // Same shape as the resume sweep: the cron job itself is keyless, and the
  // `outbound.message` jobs it sends carry `outbound:<messageId>` onto the
  // `short` queue above.
  "outbound.sweep": "standard",
  // The content engine. Three cron queues (payload `{}`), and `content.draft`,
  // whose every send carries `content-draft:<clientId>:<periodKey>`.
  "content.plan-month": "standard",
  "content.draft": "short",
  "content.publish-due": "standard",
  // Every send carries `render-image:<itemId>`, so a double-click on
  // "Generate image" or "Regenerate" collapses into one job while the first is
  // still queued. Deliberately no `singletonSeconds`: the window also covers
  // completed and failed jobs, so a day-long one would mean a picture nobody
  // liked could not be redrawn until tomorrow, and after 76f313a we know a
  // window must also fit inside the archive interval. What stops the *second*
  // spend once the first job is running is the domain layer, as it is for
  // payments: `renderContentImage` refuses an item that already has an
  // `image_url` unless a person asked for a replacement with `force`.
  "content.render-image": "short",
  "content.report": "standard",
  // The daily Ops Brief. The cron sends `{}` with no key, so `standard`; the
  // day's brief is one row per organisation per date regardless of how many
  // times the job runs (`createOpsBrief` replaces in place).
  "ops.brief": "standard",
  // Web push: every send carries `push:<notificationId>`, so a notification
  // written twice in quick succession (a retried transaction) reaches the
  // phone once.
  "push.send": "short",
  // The first-response SLA sweep: a cron, payload `{}`, one job per tick.
  "support.sla-sweep": "standard",
  // The nightly Stripe reconcile: a cron, payload `{}`, idempotent per run.
  "billing.stripe-reconcile": "standard",
  // The invoice PDF sweep: a cron, payload `{}`, one job per tick. What must
  // not happen twice is a *render*, and `ensureInvoiceDocument` guarantees that
  // at the domain layer through `invoices.document_id IS NULL` — the loser of a
  // race is handed the winner's document. Deliberately no `singletonSeconds`:
  // the sweep has to be able to run again in two minutes for the next invoice.
  "billing.invoice-documents": "standard",
  // Meetings: reminders every ten minutes, follow-ups daily. Both crons with
  // payload `{}`; every send is stamped on the meeting, so a tick is idempotent.
  "meetings.remind": "standard",
  "meetings.follow-up": "standard",
  // Proposals. `proposals.send` is `standard` rather than `short` because not
  // every send to it carries a key: the two-minute tick sends `{}`, and under
  // `short` `COALESCE(singleton_key, '')` would collapse an approved card's
  // keyed send into a tick that happened to be queued — the same reason
  // `domain.event` is `standard`. What keeps a proposal from going out twice
  // is the domain layer, as it is for payments: `sendProposal` refuses
  // anything that is not a draft, and `applyProposalSendDecision` stamps the
  // approval at most once. Deliberately no `singletonSeconds` anywhere here:
  // `job_i4` covers `failed`, so a window would mean a send that failed on a
  // bad minute could not be retried that day — and after 76f313a we know a
  // window must also fit inside `ARCHIVE_COMPLETED_AFTER_SECONDS`.
  // The handover send. Keyed `delivery-send:<projectId>`, so a double press
  // while the first is still queued is one job — and a second send once that
  // has run is legitimate (a client who lost the email needs another), which
  // core allows and the sign-off refusal is what finally closes.
  "delivery.send": "short",
  "proposals.send": "standard",
  // Every send carries `proposal-accepted:<proposalId>`, so a second
  // acceptance path (the sweep and `acceptProposal` racing) collapses while
  // the first is still queued. The job is idempotent besides.
  "proposals.accepted": "short",
  // Two daily crons: payload `{}`, no key, one job per tick is the point.
  "proposals.expire": "standard",
  "proposals.nudge": "standard",
  // The Friday fan-out: a cron, payload `{}`, no key. What must not repeat is
  // the *agent run* it sends, and that carries `dailyDedupe` on
  // `project-reporter:<projectId>:<date>` — an Opus-priced run, the same
  // reasoning as the Sentinel and the content writer. A day is well inside
  // `ARCHIVE_COMPLETED_AFTER_SECONDS`, which after 76f313a is the constraint
  // any window has to satisfy.
  "projects.weekly-update": "standard",
  // Every send carries `milestone-email:<milestoneId>`, so a re-emitted event
  // collapses while the first job is still queued. Deliberately no
  // `singletonSeconds`: `job_i4` covers `failed`, and a courtesy note that
  // failed on a bad minute must be retryable the same day — it is the one
  // email whose whole value is arriving today. What stops a second note once
  // the job is running is the domain layer, as ever: `queueMilestoneNotice`
  // claims `metadata.clientEmailedAt` before it writes anything.
  "projects.milestone-email": "short",
  // Same shape, keyed `project-delivered:<projectId>`. The screenshots and the
  // writer run behind it are both idempotent on the case study's own row.
  "projects.delivered": "short",
};

/**
 * Retry configuration for every queue, in one place.
 *
 * pg-boss resolves a job's retry limit as
 * `COALESCE(job.retry_limit, queue.retry_limit, sender_constructor_default, 2)`
 * — where the constructor default comes from *the process that sent the job*.
 * Set only on the worker's `PgBoss`, the web process's jobs (the whole
 * interactive path: inbound/outbound mail, agent resume, payments webhook,
 * domain events) would quietly retry twice with no delay. Applied here at the
 * *queue* level by `ensureQueues`, so it is the same number whichever process
 * enqueues, and passed to both `PgBoss` constructors as a belt-and-braces
 * default for any queue this table has not reached yet.
 */
export const JOB_RETRY = { retryLimit: 5, retryBackoff: true } as const;

export interface QueueSpec {
  readonly name: QueueName;
  readonly policy: QueuePolicy;
}

export const QUEUE_SPECS: readonly QueueSpec[] = Object.values(QUEUE).map((name) => ({
  name,
  policy: QUEUE_POLICY[name],
}));

/**
 * One day, in seconds. Paired with `singletonKey` on the one send whose
 * duplicate costs real money — a Sentinel agent run. `singleton_on` buckets on
 * the epoch, so this reads as "once per key per UTC day" rather than "once per
 * rolling 24 hours".
 */
export const DEDUPE_WINDOW_SECONDS = 86_400;

/**
 * How long pg-boss keeps completed and failed jobs in the live table before
 * archiving them. pg-boss refuses any `singletonSeconds` longer than this
 * ("throttling interval … cannot exceed archive interval"), and its default is
 * twelve hours — half the day `dailyDedupe` asks for. That mismatch silently
 * failed every Ad Sentinel fan-out until the worker's error alerting surfaced
 * it on 6 Sep 2026. Two days gives the day-long window headroom either side.
 * Both processes' constructors must use `BOSS_OPTIONS` so the setting cannot
 * drift between web and worker.
 */
export const ARCHIVE_COMPLETED_AFTER_SECONDS = DEDUPE_WINDOW_SECONDS * 2;

/** Constructor options every pg-boss instance in this system starts with. */
export const BOSS_OPTIONS = { ...JOB_RETRY, archiveCompletedAfterSeconds: ARCHIVE_COMPLETED_AFTER_SECONDS } as const;

/**
 * The dedupe options for a send that must not repeat within a day.
 *
 * Caveat, because the window is stronger than it looks: `job_i4` covers
 * `failed` and `completed` too, so a key sent under this window cannot be sent
 * again that UTC day *whatever happened to the first job*. That is the point
 * for the Sentinel (a repeat is an Opus-priced re-run), but it means a failed
 * Sentinel run cannot be re-dispatched by waiting — the escape hatch is a
 * manual send with a timestamped key, the way the support-triage "run now"
 * does it (`apps/web/src/app/(admin)/cases/[id]/actions.ts`). Do not reach for
 * this on a send whose only recovery path is a redelivery of the same id.
 */
export function dailyDedupe(key: string): { singletonKey: string; singletonSeconds: number } {
  return { singletonKey: key, singletonSeconds: DEDUPE_WINDOW_SECONDS };
}

/** The queue settings `ensureQueues` applies. A subset of pg-boss's `Queue`. */
export interface QueueSettings {
  readonly name: string;
  readonly policy?: QueuePolicy;
  readonly retryLimit?: number;
  readonly retryBackoff?: boolean;
}

/**
 * The slice of pg-boss this module needs. Structural, so `core` does not have
 * to import pg-boss to describe it — a `PgBoss` instance satisfies it.
 */
export interface QueueAdmin {
  createQueue(name: string, options?: QueueSettings): Promise<void>;
  updateQueue(name: string, options?: QueueSettings): Promise<void>;
}

/** The exact settings applied to one queue. Exported so tests can assert them. */
export function queueSettings(spec: QueueSpec): QueueSettings {
  return { name: spec.name, policy: spec.policy, ...JOB_RETRY };
}

/**
 * Creates every queue with its policy and retry settings, then updates it to
 * the same values.
 *
 * The update is not redundant: `create_queue` ignores conflicts, so a queue
 * that already exists (every deploy after the first, and every local database
 * created before this table did) keeps whatever settings it was first created
 * with. The update is what actually converges an existing deployment. Only the
 * columns named here are sent; the SQL COALESCEs every other column against
 * its current value, so expiry and retention are left alone.
 */
export async function ensureQueues(boss: QueueAdmin): Promise<void> {
  for (const spec of QUEUE_SPECS) {
    const options = queueSettings(spec);
    await boss.createQueue(spec.name, options);
    await boss.updateQueue(spec.name, options);
  }
}
