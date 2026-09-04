# LaunchOS — Agency OS for LaunchFlow

Management portal for Shoji, support portal for clients, two-way comms, and a framework that houses autonomous AI sub-agents. Runs the hosting, design and ad-management business.

Read this file first. Then `docs/ARCHITECTURE.md`. The design spec is `docs/superpowers/specs/2026-09-03-agency-os-design.md` and is the source of truth for scope.

## Stack (locked — do not substitute)

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm workspaces | `apps/*`, `packages/*`. Node 24. |
| Web | Next.js 16 App Router, React 19, TypeScript strict | One app, two route groups: `(admin)` and `(portal)`. |
| UI | Tailwind CSS 4 + shadcn/ui | White/light professional aesthetic. No dark decorative themes. |
| Database | PostgreSQL 17, self-hosted (docker compose locally, Coolify in prod) | **No Supabase. No hosted DB services.** |
| ORM | Drizzle ORM + drizzle-kit migrations | Schema lives in `packages/db/src/schema/*`. |
| Auth | Better Auth on our own Postgres | Roles: `owner`, `staff`, `client`. |
| Jobs / cron | pg-boss on the same Postgres | **No Redis.** |
| Worker | `apps/worker` Node process | Runs pg-boss consumers, cron schedules, agent runs. |
| AI | Claude API via `@anthropic-ai/sdk` | Default model `claude-opus-5`, adaptive thinking, server-side fallbacks on. |
| Validation | Zod at every boundary | Tool inputs, API bodies, env vars. |
| Tests | Vitest (unit/integration), Playwright (e2e) | Integration tests run against the docker Postgres. |
| Deploy | GitHub → Coolify (Hetzner) | `infra/` holds Dockerfiles and compose for Coolify. |

## Workspace layout

```
apps/web            Next.js: admin portal + client portal + API route handlers + auth
apps/worker         pg-boss consumers, cron, agent runtime host
packages/db         Drizzle schema, migrations, db client, seed
packages/core       Domain services (clients, sites, tickets, inbox, incidents, ads, approvals, audit)
packages/agents     Agent kernel + the three agents + tool adapters
packages/channels   Comms adapters: in-app, email (SMTP), whatsapp (stub)
packages/integrations  External provider clients (Coolify, Cloudflare DNS, Google Ads, Meta Ads) — mock-first
packages/ui         Reserved, not built — a README and nothing else, so pnpm does not treat it as a workspace member. Shared components live in apps/web/src/components until there is a second consumer
packages/config     Shared tsconfig / eslint / prettier
docs/               Architecture, data model, agent framework, deployment, specs, plans
infra/              Dockerfiles, compose for Coolify
```

Dependency direction is one way: `apps/*` → `packages/agents` → `packages/core` → `packages/db`. `packages/channels` and `packages/integrations` are leaves used by `core` and `agents`. Nothing imports from `apps/*`.

## Non-negotiable rules

1. **Tenancy.** Every business table has `organisation_id`. Every service function takes `organisationId` as its first argument and every query filters on it. One organisation runs today; the schema must allow selling this as SaaS without a migration.
2. **Agents never act outward without approval.** Any tool that sends a client message, changes DNS, edits site content, moves money or publishes anything is `risk: "requires_approval"`. The policy gate queues it in `approvals`; a human decides in the admin portal. Internal and mock tools are `risk: "safe"`.
3. **Every agent step is recorded.** Tool calls, inputs, outputs, decisions and LLM summaries go to `agent_runs` and `agent_steps`. Every write to a business record by any actor goes to `audit_log`. Telemetry tables (`uptime_checks`, `monitors.consecutive_failures`) and the dev seed are exempt from `audit_log`; the business actions they lead to (incident open/update, ticket create) are audited.
4. **Mock-first integrations.** Every integration exposes an interface plus a mock implementation. Real adapters are selected by env vars. Tests use mocks only.
5. **Local first, then live.** Test locally against docker Postgres. Push to GitHub only when told. Coolify auto-deploys `main`.
6. **Secrets in env only.** Never in code, seeds, docs or commits. Validate required env at startup with Zod.
7. **Immutable updates.** Return new objects; do not mutate inputs. Drizzle `update ... returning` over read-modify-write.
8. **Small files.** 200–400 lines typical, 800 max. Split by responsibility.

## Commands

```bash
pnpm install
pnpm db:up            # start local Postgres
pnpm db:migrate       # apply migrations
pnpm db:seed          # dev organisation, owner user, demo client, sites, KB
pnpm dev              # web on http://localhost:3000
pnpm dev:worker       # worker in a second terminal
pnpm test             # vitest across the workspace (needs db:up)
pnpm typecheck
```

## How to add things

- **New table:** `packages/db/src/schema/<domain>.ts` → export from `index.ts` → `pnpm db:generate` → review SQL → `pnpm db:migrate`.
- **New domain operation:** a function in `packages/core/src/<domain>/` that takes `(db, organisationId, input)`; write the Vitest test first.
- **New agent tool:** `packages/agents/src/tools/<name>.ts` exporting a `ToolDefinition` with a Zod input schema and an explicit `risk`. Add a mock if it touches the outside world.
- **New agent:** `packages/agents/src/agents/<key>/index.ts` exporting an `AgentDefinition`; register it in `packages/agents/src/agents/index.ts`; enable per organisation in `agent_enablement`.
- **New admin screen:** `apps/web/src/app/(admin)/<module>/page.tsx` using a server component that calls `core` services. Client portal screens go under `(portal)` and must scope by the signed-in user's `client_id`.

## Working with Shoji

- Direct, structured, plain English. No filler.
- Copy-paste-ready output. Break big work into small chunks.
- Test locally first. Never push live unverified.
- Use the planner / tdd-guide / code-reviewer agents as the global rules describe.
- Next.js 16 differs from older training data. Read `node_modules/next/dist/docs/` before writing routing or caching code.
