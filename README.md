# LaunchOS

Agency operating system for LaunchFlow: hosting, web design and ad management, with a management portal, a client support portal, two-way communication and autonomous AI sub-agents.

## Status

**Plans 1, 2 and 3 are implemented** on branch `build/agency-os`: the foundation plus the first vertical slice (the Hosting Guard-Dog), the client system, then the task engine.

**Plan 3 is implemented**: packages and task templates, automatic onboarding task generation on client creation, daily recurring service generation from package quantities, overdue chasing, a Tasks list and board, per-client task progress and Settings screens for the catalogue.

Working today:

- **Admin portal** (`(admin)` route group) — sign in as the owner, browse Incidents (list and detail), Tickets, Approvals, Agent Runs (run and step timeline) and Settings → Agents (enable/disable per organisation). Public self-registration is disabled; accounts come from the seed or from `/team`.
- **Worker** — pg-boss consumers and cron. The monitor sweep probes every enabled monitor, records `uptime_checks`, opens an incident after three consecutive failures and resolves it on recovery.
- **Hosting Guard-Dog agent** — triggered by `incident.opened`. Checks the site, inspects hosting, opens an internal ticket and acknowledges the incident. Every step is recorded in `agent_runs` / `agent_steps`; `requires_approval` tools park the run in `approvals`.
- **Agent kernel** — Zod-validated tools, the policy gate, run recorder, approval parking, and a fake LLM client for tests.
- **Clients** — create a client with address and contacts; each gets a slug and a `slug@SUPPORT_EMAIL_DOMAIN` support address, an empty billing profile and a timeline. Search and status filters on the list; tabs for Overview, Contacts & Billing, Sites & Domains.
- **Websites and domains** — sites belong to clients; domains belong to clients and may exist before their site; DNS records recorded per domain (pushing them to a provider stays an approval-gated agent action).
- **Team** — the owner adds a member from `/team`; the account is created with a one-time password shown exactly once. Sign-up remains disabled.
- **Shell** — grouped left navigation (later plans shown disabled), header global search over clients, websites, domains and cases, and an in-app notifications bell.
- **Database** — Drizzle schema and migrations for organisations, members, clients, contacts, billing profiles, sites, domains, DNS records, activity events, notifications, monitors, uptime checks, incidents, conversations, messages, tickets, ticket events, approvals, agent runs/steps/enablement and the audit log. Idempotent dev seed.
- **Docker images** — `infra/Dockerfile.web` and `infra/Dockerfile.worker` for Coolify.

Not built yet:

- **Plan 3** — service packages and the task engine: packages with task templates, onboarding and recurring task generation, the `/tasks` board and overdue chasing.
- **Plan 4** — client portal, inbox and the email channel, inbound routing to `support_email`, the Support Triage agent, the knowledge base, and approval resume (executing a tool after a human approves it).
- **Plan 5** — payments and invoices, the ads modules (Google and Meta), reporting, and the Ad Sentinel agent.

The full scope for Plans 3 to 5 is `docs/superpowers/specs/2026-09-04-agency-os-full-build.md`.

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
- `docs/MODULE_MAP.md` — admin and portal modules by plan, plus the `packages/core` service folders
- `docs/DEPLOYMENT.md` — local, Coolify, environment
- `docs/superpowers/specs/2026-09-03-agency-os-design.md` — the design spec
- `docs/superpowers/specs/2026-09-04-agency-os-full-build.md` — the full build spec (Plans 2 to 5)
- `docs/superpowers/plans/2026-09-03-foundation-and-hosting-guard-dog.md` — Plan 1
- `docs/superpowers/plans/2026-09-04-plan-2-client-system.md` — Plan 2, the client system
