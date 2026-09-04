# LaunchOS

Agency operating system for LaunchFlow: hosting, web design and ad management, with a management portal, a client support portal, two-way communication and autonomous AI sub-agents.

## Status

**Plan 1 is implemented** on branch `plan-1/foundation`: the foundation plus the first vertical slice, the Hosting Guard-Dog.

Working today:

- **Admin portal** (`(admin)` route group) — sign in as the owner, browse Incidents (list and detail), Tickets, Approvals, Agent Runs (run and step timeline) and Settings → Agents (enable/disable per organisation). Public self-registration is disabled; accounts come from the seed.
- **Worker** — pg-boss consumers and cron. The monitor sweep probes every enabled monitor, records `uptime_checks`, opens an incident after three consecutive failures and resolves it on recovery.
- **Hosting Guard-Dog agent** — triggered by `incident.opened`. Checks the site, inspects hosting, opens an internal ticket and acknowledges the incident. Every step is recorded in `agent_runs` / `agent_steps`; `requires_approval` tools park the run in `approvals`.
- **Agent kernel** — Zod-validated tools, the policy gate, run recorder, approval parking, and a fake LLM client for tests.
- **Database** — Drizzle schema and migrations for organisations, clients, sites, monitors, uptime checks, incidents, conversations, messages, tickets, ticket events, approvals, agent runs/steps/enablement and the audit log. Idempotent dev seed.
- **Docker images** — `infra/Dockerfile.web` and `infra/Dockerfile.worker` for Coolify.

Not built yet:

- **Plan 2** — client portal, inbox and email channel, the Support Triage agent, and approval resume (executing a tool after a human approves it).
- **Plan 3** — ads modules (Google and Meta), reporting, and the Ad Sentinel agent.

## Quick start

```bash
cp .env.example .env      # set BETTER_AUTH_SECRET and, optionally, SEED_OWNER_PASSWORD
pnpm install
pnpm db:up                # local Postgres 17 via docker compose
pnpm db:migrate
pnpm db:seed              # organisation, owner account, demo clients, sites, monitors
pnpm dev                  # http://localhost:3000
pnpm dev:worker           # second terminal
```

Sign in at `http://localhost:3000/sign-in` with the seeded owner email and `SEED_OWNER_PASSWORD` (default `change-me-now`). There is no sign-up page — the seed is the only way to create the first account.

Checks:

```bash
pnpm typecheck
pnpm lint
pnpm test                                  # vitest across the workspace (needs pnpm db:up)
pnpm --filter @launchos/web build
pnpm --filter @launchos/web exec playwright test    # e2e, needs pnpm dev running
```

## Docs

- `CLAUDE.md` — workspace rules and stack
- `docs/ARCHITECTURE.md` — runtime shape, request and job flow
- `docs/DATA_MODEL.md` — tables and relationships
- `docs/AGENT_FRAMEWORK.md` — agent kernel, tools, policy gate, the three agents
- `docs/MODULE_MAP.md` — admin and portal modules, v1 vs later
- `docs/DEPLOYMENT.md` — local, Coolify, environment
- `docs/superpowers/specs/2026-09-03-agency-os-design.md` — the design spec
- `docs/superpowers/plans/2026-09-03-foundation-and-hosting-guard-dog.md` — Plan 1
