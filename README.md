# LaunchOS

Agency operating system for LaunchFlow: hosting, web design and ad management, with a management portal, a client support portal, two-way communication and autonomous AI sub-agents.

## Status

**Plans 1 to 5 are built** on branch `build/agency-os`: the foundation and the first vertical slice, the client system, the task engine, support intake with the client portal, then money, ads and reporting.

*Built* is not the same as *verified*. Unit and integration tests cover the `packages/core` services and the agent kernel; the Playwright acceptance for Plan 4 (`apps/web/tests/e2e/support-intake.spec.ts`) needs a seeded database and a worker started with `LLM=fake`, and has not yet been recorded green end to end on a quiet machine.

Modules working today:

- **Admin portal** (`(admin)` route group) — Dashboard, Clients, Websites, Domains, Tasks, Inbox, Open Cases, Incidents, Knowledge Base, Approvals, Agent Runs, Invoices, Payments, Ads, Ad reports, Reports, Team, Account and Settings (Agents, Organisation, Email, Packages, Task templates, Billing). Public self-registration is disabled; accounts come from `pnpm db:bootstrap`, the dev seed, or `/team` — which issues a one-time password the member then replaces on `/account`.
- **Client portal** (`(portal)` route group) — a client user signs in at the same `/sign-in` and is routed to `/portal`: home, sites, domains, progress, support (raise a request, read and answer their own threads), invoices, reports and account. Every query is scoped by the `client_id` on the session; an admin route is bounced back.
- **Clients** — create a client with address and contacts; each gets a slug, a `slug@SUPPORT_EMAIL_DOMAIN` support address with a routable email identity, an empty billing profile, generated onboarding tasks and a timeline. Tabs for Overview, Contacts & Billing, Sites & Domains, Tasks, Support, Portal users, Invoices and Reports.
- **Websites and domains** — sites belong to clients; domains belong to clients and may exist before their site; DNS records recorded per domain (pushing them to a provider stays an approval-gated agent action).
- **Tasks** — packages with task templates, onboarding tasks generated when a client is created, daily recurring service generation from package quantities, overdue chasing, a list and board, and per-client progress.
- **Support intake** — mail to a client's support address reaches `POST /api/webhooks/email/inbound` (Postmark, Cloudflare Email Routing or a generic JSON shape), which validates a shared secret, stores attachments and enqueues. The worker threads it into a conversation, opens a case with an SLA due date, and files anything unrouted under the `unmatched` holding client. Staff reply or add an internal note from the unified Inbox or the case; outbound mail goes through the SMTP adapter (mock by default).
- **Knowledge base** — Markdown articles with tags and full-text search, written in `/knowledge` and searched by the Support Triage agent.
- **Money and ads** — subscriptions, invoices with VAT and overdue sweeps, payments and Stripe reconciliation, ad accounts with daily metric snapshots and signals, and monthly client reports published to the portal.
- **Worker** — pg-boss consumers and cron: the monitor sweep, inbound and outbound mail, agent runs and resumes, task generation, ad ingest, invoice overdue and monthly reports.
- **Agent kernel** — Zod-validated tools, the policy gate, run recorder, approval parking and resume, and a fake LLM client for tests. Every step lands in `agent_runs` / `agent_steps`; every outward action is parked in `approvals` for a human.
- **The three agents** — **Hosting Guard-Dog** (`incident.opened`: checks the site, inspects hosting, opens an internal ticket, acknowledges the incident), **Support Triage** (`ticket.created`: classifies, searches the knowledge base, assigns or escalates, and drafts a client reply that needs approval before it is sent), and **Ad Performance Sentinel** (07:00 daily: reads ad signals, raises a ticket and drafts a report per flagged account, with sending approval-gated).
- **Shell** — grouped left navigation, header global search over clients, websites, domains and cases, and an in-app notifications bell.
- **Database** — Drizzle schema and migrations for organisations, members, clients, contacts, billing profiles, packages, task templates, tasks, sites, domains, DNS records, email identities, knowledge articles, activity events, notifications, monitors, uptime checks, incidents, conversations, messages, tickets, ticket events, subscriptions, invoices, payments, ad accounts/snapshots/reports, client reports, approvals, agent runs/steps/enablement and the audit log. Idempotent dev seed.
- **Docker images** — `infra/Dockerfile.web` and `infra/Dockerfile.worker` for Coolify.

Needs an external account before it does anything real: an inbound mail provider and DNS control of `SUPPORT_EMAIL_DOMAIN` (inbound email), SMTP credentials (outbound email), `ANTHROPIC_API_KEY` (real agent runs), Stripe keys (real payments), and Google/Meta Ads credentials (real ad metrics). Every one of these has a mock adapter that is used until the credential is set — see `docs/DEPLOYMENT.md`.

The full scope for Plans 3 to 5 is `docs/superpowers/specs/2026-09-04-agency-os-full-build.md`.

## Quick start

```bash
cp .env.example .env
openssl rand -base64 48   # paste into BETTER_AUTH_SECRET in .env — it ships blank
openssl rand -base64 48   # and again, into INBOUND_EMAIL_SECRET — it ships blank too
pnpm install
pnpm db:up                # local Postgres 17 via docker compose
pnpm db:migrate
pnpm db:seed              # organisation, owner, demo clients, sites, monitors, knowledge, a support case, a portal login
pnpm dev                  # http://localhost:3000
pnpm dev:worker           # second terminal
```

`BETTER_AUTH_SECRET` and `INBOUND_EMAIL_SECRET` are the two variables `.env.example` cannot supply, because a value published in this repository is not a secret. The first signs every session cookie; the second is the only credential on `POST /api/webhooks/email/inbound`, so a published one lets anyone manufacture conversations and raise tickets against any client. The web app refuses to start on a blank value, on one under 32 (auth) or 24 (inbound) characters, and on any placeholder shipped here — in every environment, not only production. Set both in your local `.env` before `pnpm dev`; the e2e suite reads `INBOUND_EMAIL_SECRET` from that same file and fails by name if it is unset. On Windows, `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` does the same job as `openssl rand -base64 48`.

Sign in at `http://localhost:3000/sign-in` with the seeded owner email and `SEED_OWNER_PASSWORD` (default `change-me-now`). There is no sign-up page. The same page signs in the seeded client user (`SEED_CLIENT_EMAIL`, default `portal@grayscabline.example`, password `SEED_CLIENT_PASSWORD`, default `change-me-client`) and routes it to `/portal`.

`pnpm db:seed` is development only — it writes demo clients, invoices with numbers from a live sequence, ad data and a portal login — and it refuses to run at all unless `SEED_DEMO=1`, in every environment and against every host. `.env.example` ships that flag set, so the quick start above needs nothing extra; a production resource must never carry it. A production install runs `pnpm db:bootstrap` instead: the organisation (`SEED_ORG_NAME` / `SEED_ORG_SLUG`) and the owner account (`SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`) and nothing else.

Because the bootstrap is the production tool, its guards hold **everywhere**: it refuses a password that is still a published default, requires `SEED_OWNER_EMAIL` (it has no default) and requires `BOOTSTRAP_CONFIRM` to equal the slug it would write, in every environment and against every host — a tunnelled or private-network production database is indistinguishable from a local one by its hostname. Running it locally therefore looks like this:

```bash
SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='a-real-long-password' BOOTSTRAP_CONFIRM=launchflow pnpm db:bootstrap
```

See `docs/DEPLOYMENT.md`.

Checks:

```bash
pnpm typecheck
pnpm lint
pnpm test                                  # vitest across the workspace (needs pnpm db:up)
pnpm --filter @launchos/web build
pnpm --filter @launchos/web e2e            # Playwright; needs pnpm dev, a seeded database and the worker below
```

`pnpm test` is vitest over `src/**/*.test.ts` only. The Playwright specs live outside that pattern (`apps/web/tests/e2e/*.spec.ts`) and are **not** part of it, so a green `pnpm test` is not "the tests" — run the e2e line above as well before calling a branch verified. Vitest also passes a package with no discovered test files rather than failing it, so a suite that stops being matched goes quiet rather than red.

The end-to-end specs drive real jobs, so the worker has to be up. Start it with the fake model so agent runs are deterministic, need no API key and cost nothing:

```bash
LLM=fake pnpm dev:worker                     # bash
$env:LLM = "fake"; pnpm dev:worker           # PowerShell
```

With `LLM=fake` the worker answers every Support Triage run with a scripted `messages_reply_to_client` call (`apps/worker/src/llm/fake.ts`), which is what parks the approval the Plan 4 acceptance approves and then watches reach `sent`. The specs read the seeded logins from `apps/web/tests/e2e/seed-credentials.ts`, and `playwright.config.ts` loads the repo-root `.env`, so whatever `SEED_*` values you seeded with reach them.

## Docs

- `CLAUDE.md` — workspace rules and stack
- `docs/ARCHITECTURE.md` — runtime shape, request and job flow
- `docs/DATA_MODEL.md` — tables and relationships
- `docs/AGENT_FRAMEWORK.md` — agent kernel, tools, policy gate, the three agents
- `docs/MODULE_MAP.md` — admin and portal modules by plan, plus the `packages/core` service folders
- `docs/DEPLOYMENT.md` — local, Coolify, environment
- `docs/superpowers/specs/2026-09-03-agency-os-design.md` — the design spec
- `docs/superpowers/specs/2026-09-04-agency-os-full-build.md` — the full build spec (Plans 2 to 5)
- `docs/superpowers/plans/2026-09-03-foundation-and-hosting-guard-dog.md` — Plan 1, foundation and the Hosting Guard-Dog
- `docs/superpowers/plans/2026-09-04-plan-2-client-system.md` — Plan 2, the client system
- `docs/superpowers/plans/2026-09-04-plan-3-task-engine.md` — Plan 3, packages and the task engine
- `docs/superpowers/plans/2026-09-04-plan-4-support-and-portal.md` — Plan 4, support intake and the client portal
- `docs/superpowers/plans/2026-09-04-plan-5-payments-ads-reports.md` — Plan 5, payments, ads and reporting
