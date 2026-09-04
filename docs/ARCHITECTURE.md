# Architecture

Companion to `CLAUDE.md` and the spec in `docs/superpowers/specs/`. This page explains how the pieces fit at runtime.

## Processes

| Process | Package | Responsibility |
|---|---|---|
| web | `apps/web` | Next.js 16. Admin portal `(admin)`, client portal `(portal)`, Better Auth routes, webhook route handlers that validate and enqueue. |
| worker | `apps/worker` | Long-lived Node process. Boots pg-boss, registers cron schedules, consumes queues, hosts the agent kernel. |
| postgres | docker / Coolify | Application schema plus the `pgboss` schema. |

Both processes import the same `packages/*` and read the same `DATABASE_URL`. They scale independently on Coolify.

`next dev` re-evaluates a module on every recompile, so `apps/web/src/lib/db.ts` and `apps/web/src/lib/queue.ts` cache their Postgres client and pg-boss instance on `globalThis` in development — without it each edit leaks a connection pool until Postgres runs out. Production keeps the plain module-scope cache.

## Layers and dependency direction

```
apps/web, apps/worker
        │
packages/agents        kernel, tools, agent definitions
        │
packages/core          domain services, one folder per domain
        │
packages/db            Drizzle schema, migrations, client
packages/channels      email / in-app / whatsapp adapters   (leaf, used by core + agents)
packages/integrations  coolify / cloudflare / google-ads / meta-ads adapters (leaf, mock-first)
```

Rules: no upward imports; `db` knows nothing about domains; `core` never calls the LLM; only `agents` talks to Claude.

## Core service contract

Every service function has the shape:

```ts
export async function createTicket(db: Db, organisationId: string, input: CreateTicketInput): Promise<Ticket>
```

`organisationId` first, always. Inputs are Zod-validated types exported next to the function. Writes append to `audit_log` inside the same transaction.

## Queues (pg-boss)

| Queue | Policy | Producer | Consumer | Payload |
|---|---|---|---|---|
| `monitor.check` | standard | cron every minute | worker | `{}` — sweeps every organisation, per-monitor checks inside |
| `agent.run` | short | events, cron, admin "run now" | worker | `{ agentKey, organisationId, trigger, payload }` |
| `agent.resume` | short | the approvals screen (fast path), `approval.decided` event, and `approvals.resume-sweep` | worker | `{ organisationId, runId, approvalId, decision, note? }` — no approver: the kernel reads `approvals.decided_by` |
| `inbound.message` | short | `email.received` event (webhook route handler enqueues) | worker | `{ organisationId, inbound }` — normalised inbound email + provider |
| `outbound.message` | short | `message.queued` event (core / approval) and `outbound.sweep` | worker | `{ organisationId, messageId }` |
| `domain.event` | standard | any web server action that emits a domain event | worker | the `DomainEvent` itself — no `singletonKey`, hence `standard` |
| `ads.ingest` | standard | cron daily 06:30 Europe/London | worker | `{}` — sweeps every organisation, ingesting yesterday's ad metrics |
| `tasks.generate-onboarding` | short | `client.created` event, routed only by the worker's `dispatchEvent` (web emits the event but never enqueues this job directly — see Events below) | worker | `{ organisationId, clientId }` |
| `tasks.generate-recurring` | standard | cron daily 06:00 Europe/London | worker | `{}` — sweeps every active organisation |
| `tasks.check-overdue` | standard | cron daily 08:00 Europe/London | worker | `{}` — sweeps every active organisation |
| `payments.webhook` | short | Stripe webhook route (`apps/web/src/app/api/webhooks/stripe`) enqueues directly via `sendJob` after verifying the signature and resolving tenancy | worker | `{ organisationId, providerEvent }` |
| `ads.sentinel` | standard | cron daily 07:00 Europe/London | worker | `{}` — fans out to one `agent.run { agentKey: "ad-performance-sentinel" }` per organisation with the Sentinel enabled |
| `invoices.check-overdue` | standard | cron daily 07:30 Europe/London | worker | `{}` — sweeps every organisation, flagging invoices past due and raising a billing ticket each |
| `approvals.resume-sweep` | standard | cron every minute | worker | `{}` — per organisation, re-enqueues `agent.resume` for every approval decided more than 30s ago whose run is still `awaiting_approval` **and still parked on that approval's own tool call** (`metadata.pending ->> 'awaitingToolUseId' = payload ->> 'toolUseId'`, the binding the kernel enforces — a re-parked run therefore stops matching). The decision is final; only its *delivery* is repaired here, keyed `resume:<approvalId>` so an already-queued job is deduped |
| `outbound.sweep` | standard | cron every minute | worker | `{}` — per organisation, re-enqueues `outbound.message` for every message still `status = 'queued'` between 60s and 24h old, keyed `outbound:<messageId>`. The row is committed before the job is sent, so a lost enqueue would otherwise leave a reply on the thread that is never delivered and never noticed |
| `agent-runs.stuck-sweep` | standard | cron every ten minutes | worker | `{}` — per organisation, fails runs still `running` with no step for 30 minutes (and a `metadata.resume.claimedAt` at least that old), writing `agent.run_stranded` and notifying the owner. The status flip and the audit row are one transaction; the notification is best effort after it. This is the only mechanism that closes a stranded run — the kernel's in-band five-minute equivalent is gone, because it guessed from a timestamp and could fail a resume that was still working |
| `reports.monthly` | standard | cron 07:45 Europe/London on the 1st — deliberately after `ads.ingest` (06:30) so the final day of the month's ad spend is in, and after `invoices.check-overdue` (07:30) | worker | `{}` — drafts last month's report for every active client in every organisation |

Queue names, policies and retry settings are defined once, in `packages/core/src/queue/queues.ts`, and applied by both processes through `ensureQueues` — pg-boss's `create_queue` ignores conflicts, so whichever process booted first would otherwise fix a queue's settings for good. `apps/worker/src/queues.integration.test.ts` asserts that convergence, and the dedupe behaviour below, against a real pg-boss in a throwaway schema.

**What deduplication actually guarantees.** A `singletonKey` on `send` is inert on its own: pg-boss enforces dedupe only through partial unique indexes, and none of them apply under the default `standard` policy. So:

- Queues whose every send carries a key are created `short`, whose index is `UNIQUE (name, COALESCE(singleton_key,'')) WHERE state = 'created'`. The exact guarantee is therefore: **a duplicate is collapsed only while the first job is still queued.** The moment the worker picks that job up the key is free again — not "exactly once", and not even "once per run".
- `stately` (which also constrains `retry` and `active`) is deliberately **not** used. Its index is keyed on `(name, state, key)`, so a duplicate sent while the first job is `active` inserts legally as `created` and then violates the index when pg-boss promotes it. The `UPDATE` aborts and pg-boss swallows the error, so the fetch returns nothing and logs nothing — and since it orders by `created_on LIMIT 1`, that stuck row blocks the queue for every tenant until the active job ends. Two ordinary paths trigger it: a second press of Approve while `agent.resume` runs, and a retried `domain.event` re-sending `tasks.generate-onboarding`.
- One send needs a guarantee that outlives completion, because a duplicate costs Opus tokens and there is no domain-level equivalent: the Sentinel fan-out (`ad-sentinel:<org>:<date>`), which passes `singletonSeconds` (one day, `dailyDedupe`). That window also covers `failed`, so a Sentinel run that fails cannot be re-dispatched by this path until the next UTC day; the escape hatch is a manual send with a timestamped key, as the support-triage "run now" already does.
- The Stripe webhook uses a plain key and no window, on purpose: a window would drop the "Resend" that is a failed payment sync's only recovery path, silently. Redelivery is answered by the domain layer instead.
- Everything stronger is enforced at the domain layer, not the queue: the unique `(organisation_id, provider, provider_ref)` index behind `syncFromPaymentsEvent`, `resumeAgent` refusing an already-decided approval, the idempotent report upsert.

**Retries.** `retryLimit: 5` with exponential backoff, set on the queue row itself by `ensureQueues` (`JOB_RETRY`). It has to live on the queue, not on a `PgBoss` constructor: pg-boss resolves a job's limit as `COALESCE(job, queue, sending-process default, 2)`, so a constructor-only setting would give web-enqueued jobs — the whole interactive path — two attempts and no delay while worker-enqueued jobs got five. Both constructors pass `JOB_RETRY` as well, as a fallback for a queue `ensureQueues` has not reached yet. No dead-letter queue is configured; an exhausted job lands in `failed`.

Every cron sweep isolates each organisation (and each client/invoice/ad account inside it) behind its own try/catch, logs the failure with the id, finishes the rest of the list, and re-throws once at the end so the job is still marked failed — one bad row can never cost the other organisations their sweep. That loop is `apps/worker/src/jobs/sweep-organisations.ts`, and the Sentinel fan-out is `apps/worker/src/jobs/ads-sentinel.ts`; both live outside `main()` so they can be tested.

## Events

Domain events are plain function calls into `packages/core/src/events/emit.ts` (`emit`/`setEnqueue`), which only carries the event to whichever `EnqueueFn` the running process registered — `core` stays unaware of pg-boss or agents. Until a process calls `setEnqueue`, `emit` is a silent no-op: that is why every web entry point that emits (a server action, the inbound webhook) calls `installWebEnqueue()` first, and why the seed can call `ingestInboundEmail` without dispatching anything.

The event-name-to-job routing table lives in one place, `apps/worker/src/jobs/dispatch-event.ts`, so it can be unit tested with a fake `boss.send`:

| Event | Job |
|---|---|
| `incident.opened` | `agent.run { agentKey: "hosting-guard-dog" }` |
| `ticket.created` | `agent.run { agentKey: "support-triage" }` |
| `email.received` | `inbound.message` |
| `message.queued` | `outbound.message` |
| `approval.decided` | `agent.resume` |
| `client.created` | `tasks.generate-onboarding`, plus `ensureEmailIdentity` |
| `payments.webhook` | `payments.webhook` |

The enablement check happens inside `handleAgentRun`, not in the routing table. `payments.webhook` is kept here for symmetry — in practice the Stripe route enqueues that job directly, as the approvals screen enqueues `agent.resume` directly: the decision is already committed by then, so that send is a fast path whose failure is logged rather than surfaced, and `approvals.resume-sweep` re-drives anything it missed.

**When a send fails, what throws and what does not.** `email.received` still throws: nothing has committed at that point, and the inbound webhook route turns the throw into a 500 so the provider redelivers — the only thing that can recover the mail. `message.queued` and the generic `domain.event` branch do not: `emit` runs *after* the core service committed, so throwing turns a saved write into "Something went wrong" and invites a retry that writes a second row. Both log and best-effort notify the owner instead. The difference between them is what happens next: a dropped `domain.event` fan-out has to be re-run by hand, while a `queued` message is re-driven automatically by `outbound.sweep` within a minute.

`apps/web/src/lib/queue.ts` implements the web half. It short-circuits the three events whose target queue it already knows — `email.received` → `inbound.message`, `message.queued` → `outbound.message`, `approval.decided` → `agent.resume`, each with the same singleton key the worker uses — and puts everything else onto the generic `domain.event` queue for `dispatchEvent` to route. The duplication is deliberate: nothing may import from `apps/*` into `apps/*`. It also means **the two files have to be kept in step**; a singleton key that differs between them would let the same work be queued twice.

## Webhooks

Route handlers under `apps/web/src/app/api/webhooks/` are the only unauthenticated entry points. They validate, normalise and enqueue; they never write a business record, so a slow database cannot spend the provider's timeout budget.

**`POST /api/webhooks/email/inbound`** — inbound support mail.

1. Compares the `x-launchos-inbound-secret` header against `INBOUND_EMAIL_SECRET` with `timingSafeEqual`, rejecting a length mismatch before comparing so the length is not leaked. No match is a 401 and nothing else runs.
2. Caps the body (20MB) and rejects a payload it cannot parse.
3. Normalises by provider — `?provider=postmark|cloudflare|generic`, falling back to `INBOUND_EMAIL_PROVIDER`. A payload that does not fit the provider's shape is a **422**, not a 500: a malformed message is the provider's problem and must not be retried forever.
4. Resolves the organisation by matching a recipient against `email_identities.address`. With no match, the oldest active organisation owns the mail and the ingest files it under that organisation's `unmatched` holding client.
5. Writes attachments to `STORAGE_DIR` under generated names (the provider's filename is reduced to its basename first), so the queue payload stays small.
6. Emits `email.received` and returns **202**.

Everything after that is the worker: `handleInboundMessage` calls `ingestInboundEmail`, which threads the message, opens or reuses a case and emits `ticket.created`. Attachments are served back by `GET /api/attachments/[org]/[file]`, which requires an admin session and refuses any organisation but the caller's.

**`POST /api/webhooks/stripe`** — verifies the Stripe signature, resolves tenancy from the customer id and enqueues `payments.webhook` directly. It refuses with 503 unless the real Stripe adapter is configured, so it can never accept a mock-signed event.

## Auth and tenancy

Better Auth issues sessions. A request resolves to `{ userId, organisationId, role, clientId? }` via `apps/web/src/lib/session.ts`. Admin routes require `owner` or `staff`. Portal routes require a `client_users` row and inject `clientId` into every core call. There is no way to pass `clientId` from the URL into a portal query.

## Agent runtime

See `docs/AGENT_FRAMEWORK.md`.

## Integrations

Each integration in `packages/integrations` exports an interface and two implementations: `Mock*` and the real client. `createIntegrations(env)` picks the real one only when its env vars are present. Agents and core only ever see the interface.
