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

| Queue | Producer | Consumer | Payload |
|---|---|---|---|
| `monitor.check` | cron every minute | worker | `{ organisationId }` fan-out to per-monitor checks |
| `agent.run` | events, cron, admin "run now" | worker | `{ agentKey, organisationId, trigger, payload }` |
| `agent.resume` | `approval.decided` event | worker | `{ organisationId, runId, approvalId, decision, note?, decidedByUserId? }` |
| `inbound.message` | `email.received` event (webhook route handler enqueues) | worker | `{ organisationId, inbound }` — normalised inbound email + provider |
| `outbound.message` | `message.queued` event (core / approval) | worker | `{ organisationId, messageId }` |
| `ads.ingest` | cron daily | worker | `{ organisationId }` |
| `tasks.generate-onboarding` | `client.created` event, routed only by the worker's `dispatchEvent` (web emits the event but never enqueues this job directly — see Events below) | worker | `{ organisationId, clientId }` |
| `tasks.generate-recurring` | cron daily 06:00 Europe/London | worker | `{}` — sweeps every active organisation |
| `tasks.check-overdue` | cron daily 08:00 Europe/London | worker | `{}` — sweeps every active organisation |

Every job carries a `singletonKey` derived from its natural key so duplicates collapse. Retry limit 5 with exponential backoff, then dead-letter.

## Events

Domain events are plain function calls into `packages/core/src/events/emit.ts` (`emit`/`setEnqueue`), which only carries the event to whichever `EnqueueFn` the running process registered — `core` stays unaware of pg-boss or agents. The actual event-name-to-job routing table lives in one place, `apps/worker/src/jobs/dispatch-event.ts`, so it can be unit tested with a fake `boss.send`. Example: `ticket.created` → `agent.run { agentKey: "support-triage" }` (the enablement check itself happens inside `handleAgentRun`, not the routing table). Other mappings: `client.created` → `tasks.generate-onboarding` + `ensureEmailIdentity`; `email.received` → `inbound.message`; `message.queued` → `outbound.message`; `approval.decided` → `agent.resume`.

## Auth and tenancy

Better Auth issues sessions. A request resolves to `{ userId, organisationId, role, clientId? }` via `apps/web/src/lib/session.ts`. Admin routes require `owner` or `staff`. Portal routes require a `client_users` row and inject `clientId` into every core call. There is no way to pass `clientId` from the URL into a portal query.

## Agent runtime

See `docs/AGENT_FRAMEWORK.md`.

## Integrations

Each integration in `packages/integrations` exports an interface and two implementations: `Mock*` and the real client. `createIntegrations(env)` picks the real one only when its env vars are present. Agents and core only ever see the interface.
