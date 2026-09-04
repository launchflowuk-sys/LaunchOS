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
| `agent.run` | stately | events, cron, admin "run now" | worker | `{ agentKey, organisationId, trigger, payload }` |
| `agent.resume` | stately | `approval.decided` event | worker | `{ organisationId, runId, approvalId, decision, note?, decidedByUserId? }` |
| `inbound.message` | stately | `email.received` event (webhook route handler enqueues) | worker | `{ organisationId, inbound }` — normalised inbound email + provider |
| `outbound.message` | stately | `message.queued` event (core / approval) | worker | `{ organisationId, messageId }` |
| `domain.event` | standard | any web server action that emits a domain event | worker | the `DomainEvent` itself — no `singletonKey`, hence `standard` |
| `ads.ingest` | standard | cron daily 06:30 Europe/London | worker | `{}` — sweeps every organisation, ingesting yesterday's ad metrics |
| `tasks.generate-onboarding` | stately | `client.created` event, routed only by the worker's `dispatchEvent` (web emits the event but never enqueues this job directly — see Events below) | worker | `{ organisationId, clientId }` |
| `tasks.generate-recurring` | standard | cron daily 06:00 Europe/London | worker | `{}` — sweeps every active organisation |
| `tasks.check-overdue` | standard | cron daily 08:00 Europe/London | worker | `{}` — sweeps every active organisation |
| `payments.webhook` | stately | Stripe webhook route (`apps/web/src/app/api/webhooks/stripe`) enqueues directly via `sendJob` after verifying the signature and resolving tenancy | worker | `{ organisationId, providerEvent }` |
| `ads.sentinel` | standard | cron daily 07:00 Europe/London | worker | `{}` — fans out to one `agent.run { agentKey: "ad-performance-sentinel" }` per organisation with the Sentinel enabled |
| `invoices.check-overdue` | standard | cron daily 07:30 Europe/London | worker | `{}` — sweeps every organisation, flagging invoices past due and raising a billing ticket each |
| `reports.monthly` | standard | cron 07:45 Europe/London on the 1st — deliberately after `ads.ingest` (06:30) so the final day of the month's ad spend is in, and after `invoices.check-overdue` (07:30) | worker | `{}` — drafts last month's report for every active client in every organisation |

Queue names and policies are defined once, in `packages/core/src/queue/queues.ts`, and applied by both processes through `ensureQueues` — pg-boss's `create_queue` ignores conflicts, so whichever process booted first would otherwise fix a queue's policy for good.

**What deduplication actually guarantees.** A `singletonKey` on `send` is inert on its own: pg-boss enforces dedupe only through partial unique indexes, and none of them apply under the default `standard` policy. So:

- Queues whose every send carries a key are created `stately`: at most one job per `(queue, singletonKey)` in each of the `created`, `retry` and `active` states. A duplicate send collapses **while the first job is still in flight** — it is not "exactly once for all time": once a job completes, the same key can be sent again.
- Two sends need a guarantee that outlives completion, because a duplicate costs Opus tokens or reaches a client: the Sentinel fan-out (`ad-sentinel:<org>:<date>`) and the Stripe webhook (`stripe:<eventId>`). Both pass `singletonSeconds` (one day, `dailyDedupe`), which is the only thing that makes pg-boss's `singleton_on` index apply.
- Everything stronger is enforced at the domain layer, not the queue: the unique `(organisation_id, provider, provider_ref)` index behind `syncFromPaymentsEvent`, `resumeAgent` refusing an already-decided approval, the idempotent report upsert.

Retry limit 5 with exponential backoff, then dead-letter. Every cron sweep isolates each organisation (and each client/invoice/ad account inside it) behind its own try/catch, logs the failure with the id, finishes the rest of the list, and re-throws once at the end so the job is still marked failed — one bad row can never cost the other organisations their sweep.

## Events

Domain events are plain function calls into `packages/core/src/events/emit.ts` (`emit`/`setEnqueue`), which only carries the event to whichever `EnqueueFn` the running process registered — `core` stays unaware of pg-boss or agents. The actual event-name-to-job routing table lives in one place, `apps/worker/src/jobs/dispatch-event.ts`, so it can be unit tested with a fake `boss.send`. Example: `ticket.created` → `agent.run { agentKey: "support-triage" }` (the enablement check itself happens inside `handleAgentRun`, not the routing table). Other mappings: `client.created` → `tasks.generate-onboarding` + `ensureEmailIdentity`; `email.received` → `inbound.message`; `message.queued` → `outbound.message`; `approval.decided` → `agent.resume`; `payments.webhook` → `payments.webhook` (kept in the routing table for symmetry — in practice the Stripe route enqueues this job directly rather than through `emit`).

## Auth and tenancy

Better Auth issues sessions. A request resolves to `{ userId, organisationId, role, clientId? }` via `apps/web/src/lib/session.ts`. Admin routes require `owner` or `staff`. Portal routes require a `client_users` row and inject `clientId` into every core call. There is no way to pass `clientId` from the URL into a portal query.

## Agent runtime

See `docs/AGENT_FRAMEWORK.md`.

## Integrations

Each integration in `packages/integrations` exports an interface and two implementations: `Mock*` and the real client. `createIntegrations(env)` picks the real one only when its env vars are present. Agents and core only ever see the interface.
