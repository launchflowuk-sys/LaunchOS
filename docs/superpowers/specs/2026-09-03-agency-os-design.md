# LaunchOS Agency OS — Design Spec

Date: 2026-09-03. Status: approved by Shoji (stack defaults accepted).

## 1. Purpose

One system to run the LaunchFlow agency: hosting, website design and ad management for UK local-service clients.

- **Admin portal** (Shoji and staff): clients, sites, hosting, domains, unified inbox, tickets, ad accounts, incidents, approvals, agent runs, knowledge base.
- **Client portal**: their sites and hosting status, their tickets and messages, their ad performance summaries.
- **Two-way communication**: in-app threads and email in both directions, on one conversation model. WhatsApp via Twilio later on the same model.
- **Agent framework**: a kernel that houses autonomous sub-agents with recorded runs, typed tools and a human approval gate. Three agents ship: Support Triage, Ad Performance Sentinel, Hosting Guard-Dog.

## 2. Decisions (locked)

| Question | Decision | Why |
|---|---|---|
| Relationship to old LaunchFlow OS prototype | Fresh build. Port its Drizzle schema ideas, docs and shadcn components selectively. Do not port mock/selector/local-ops layers or the shadow-read machinery. | Prototype has no auth, backend, git or portal; every screen reads mock data; 14 of its 15 largest files are mock plumbing. |
| Runtime | pnpm monorepo: `apps/web` (Next.js 16) + `apps/worker` (Node). | Matches Funnel Engine and Cabio precedents. One Coolify stack. |
| Database | Self-hosted PostgreSQL 17 + Drizzle. No Supabase, no hosted DB. | Shoji wants a locally controlled DB. |
| Auth | Better Auth on own Postgres. Roles `owner`, `staff`, `client`. | No external auth service. |
| Tenancy | `organisation_id` on every business table from day one. One organisation in production. | Sellable as SaaS later without migration. |
| Queue | pg-boss on Postgres. No Redis. | One fewer service to run. |
| Email | Channel adapter interface; SMTP (Nodemailer) is the default adapter. Inbound via provider webhook. | Provider-agnostic; Shoji has not picked a provider. |
| WhatsApp | After v1, Twilio adapter on the same channel interface. | Twilio already used in Agent Zero. |
| Billing / invoices | Out of v1. | Keep v1 spine tight. |
| Agent policy | Safe tools run automatically. Outward-facing tools queue for human approval. | Prototype's automation-boundaries doc; Shoji confirmed. |
| AI | Claude API, `@anthropic-ai/sdk`, model `claude-opus-5`, adaptive thinking, server-side fallbacks enabled. | Per claude-api guidance. |

## 3. Architecture

```
                 ┌──────────────────────────── Coolify (Hetzner) ────────────────────────────┐
  Browser ──────►│  apps/web (Next.js 16)                                                    │
  (admin/client) │   ├─ (admin)/*  server components → packages/core                        │
                 │   ├─ (portal)/* server components → packages/core (scoped by client_id)  │
                 │   ├─ /api/auth/[...all]  Better Auth                                      │
                 │   └─ /api/webhooks/{email,uptime,ads}  → validate → enqueue pg-boss job   │
                 │                                    │                                      │
                 │  PostgreSQL 17  ◄──────────────────┼──────────────────────┐               │
                 │   (app schema + pgboss schema)     │                      │               │
                 │                                    ▼                      │               │
                 │  apps/worker (Node)                                       │               │
                 │   ├─ pg-boss consumers: monitor.check, agent.run,         │               │
                 │   │   inbound.message, outbound.message, ads.ingest       │               │
                 │   ├─ cron: monitor.check */1m, ads.ingest daily, ad-sentinel daily        │
                 │   └─ packages/agents kernel ──► Claude API                                │
                 └────────────────────────────────────────────────────────────────────────────┘
```

**Request flow.** Portal pages are server components calling `core` services with the session's `organisationId` and, for clients, `clientId`. Mutations are route handlers or server actions that validate with Zod, call `core`, and write `audit_log`.

**Job flow.** Anything slow, scheduled or agentic goes through pg-boss. Webhooks only validate and enqueue. The worker consumes.

**Agent flow.** A trigger (cron, event such as `ticket.created` or `incident.opened`, or manual) enqueues `agent.run` with `{agentKey, organisationId, payload}`. The kernel loads the `AgentDefinition`, opens an `agent_runs` row, runs the LLM tool loop, records each step, executes `safe` tools immediately, and for `requires_approval` tools writes an `approvals` row and parks the run as `awaiting_approval`. Approving in the admin portal enqueues `agent.resume` with the stored tool call.

## 4. Data model (v1)

Shared columns on every business table: `id uuid pk default gen_random_uuid()`, `organisation_id uuid fk`, `created_at`, `updated_at`, `deleted_at` nullable, `metadata jsonb default '{}'`.

**System.** `organisations`, Better Auth tables (`user`, `session`, `account`, `verification`), `organisation_members (user_id, role: owner|staff)`, `client_users (user_id, client_id, role: client_admin|client_member)`.

**Clients.** `clients (name, trading_name, email, phone, status, notes)`, `client_contacts (client_id, name, email, phone, role, is_primary)`.

**Sites and hosting.** `sites (client_id, name, primary_url, platform: wordpress|static|nextjs|other, hosting_provider: coolify|other, hosting_ref, status)`, `domains (site_id, name, registrar, expires_at, auto_renew, status)`, `dns_records (domain_id, type, name, value, ttl, proxied)`.

**Communication.** `conversations (client_id, site_id?, subject, channel: portal|email|whatsapp|internal, status, last_message_at)`, `messages (conversation_id, direction: inbound|outbound|internal, author_kind: user|client|agent|system, author_id?, body, external_id?, delivered_at?)`, `tickets (conversation_id, client_id, site_id?, subject, category, severity: low|medium|high|critical, status: open|triaged|in_progress|waiting_client|resolved|closed, assigned_user_id?, escalated: bool, escalation_reason?)`, `ticket_events (ticket_id, kind, actor_kind, actor_id?, data)`.

**Ads.** `ad_accounts (client_id, platform: google|meta, external_id, name, currency, status)`, `ad_metric_snapshots (ad_account_id, date, spend, impressions, clicks, conversions, conversion_value, cpc, roas)` unique on `(ad_account_id, date)`, `ad_reports (ad_account_id, period_start, period_end, summary_md, status: draft|approved|sent, agent_run_id?)`.

**Knowledge.** `knowledge_articles (title, slug, body_md, tags text[], search tsvector generated, published)`.

**Monitoring.** `monitors (site_id, kind: http|ssl|resource, target, interval_seconds, enabled)`, `uptime_checks (monitor_id, checked_at, ok, status_code?, latency_ms?, error?)`, `incidents (site_id, monitor_id?, ticket_id?, status: open|acknowledged|resolved, severity, title, summary_md, opened_at, resolved_at?, agent_run_id?)`.

**Agents and governance.** `agent_enablement (agent_key, enabled, config jsonb)` unique on `(organisation_id, agent_key)`, `agent_runs (agent_key, trigger, status: running|completed|awaiting_approval|failed, input, summary, error?, started_at, finished_at?)`, `agent_steps (run_id, seq, kind: llm|tool_call|tool_result|approval_requested|note, tool_name?, input, output, tokens_in?, tokens_out?)`, `approvals (run_id?, step_id?, kind, title, payload, status: pending|approved|rejected, decided_by?, decided_at?, decision_note?)`, `audit_log (actor_kind, actor_id?, action, target_type, target_id, before, after)`.

Full column detail is in `docs/DATA_MODEL.md`.

## 5. Agent framework

**Kernel** (`packages/agents/src/kernel`):
- `types.ts`: `ToolDefinition { name, description, input: ZodSchema, risk: "safe" | "requires_approval", execute(input, ctx) }`, `AgentDefinition { key, name, description, trigger, systemPrompt, tools, maxTurns, model? }`, `AgentContext { organisationId, runId, db, logger, now }`.
- `tool-registry.ts`: converts tool definitions to Claude tool schemas (Zod → JSON Schema, `strict: true`).
- `policy-gate.ts`: `decide(tool, policy) → "execute" | "queue_approval"`. `AGENT_POLICY=approval_all` forces everything to queue.
- `run-recorder.ts`: opens runs, appends steps, closes runs.
- `llm.ts`: `LlmClient` interface with `complete()`; `AnthropicLlmClient` implementation; `FakeLlmClient` for tests.
- `run-agent.ts`: manual tool loop. Parallel tool calls are executed together and all results are returned in one user message. Stops on `end_turn`, `maxTurns`, an approval request, or an error.

**Tools** (`packages/agents/src/tools`): `uptime.check_site` (safe, mock HTTP probe), `hosting.get_resources` (safe, mock Coolify), `dns.update_record` (requires_approval, mock Cloudflare), `cms.update_content` (requires_approval, mock), `knowledge.search` (safe, Postgres full text), `tickets.create|update|escalate` (safe, internal), `messages.reply_to_client` (requires_approval), `ads.get_metrics` (safe, reads snapshots), `ads.save_draft_report` (safe, writes draft).

**Agents** (`packages/agents/src/agents`):
1. **Support Triage** — trigger `event: ticket.created`. Reads the ticket and conversation, searches the knowledge base, classifies category and severity, updates the ticket, and either drafts a reply (approval) with a proposed DNS/content fix (approval) or escalates to Shoji with a reason.
2. **Ad Performance Sentinel** — trigger `cron daily 07:00 Europe/London`. For each active ad account, compares the last 7 days to the prior 7: flags ROAS drop over 20 percent or CPC rise over 30 percent, opens an internal ticket per flagged account, and drafts a client-facing summary into `ad_reports` as `draft` (sending is an approval).
3. **Hosting Guard-Dog** — deterministic `monitor.check` cron every minute records `uptime_checks`. On 3 consecutive failures the worker opens an incident and enqueues the agent, which diagnoses with `uptime.check_site` and `hosting.get_resources`, writes the incident summary, creates an internal ticket, and marks the incident `acknowledged`. Recovery closes the incident automatically.

## 6. Portals and modules (v1)

Admin: Dashboard, Clients, Sites (hosting, domains, DNS), Inbox, Tickets, Ads, Incidents, Approvals, Agent Runs, Knowledge Base, Settings (members, agent enablement).
Client portal: Home, My Sites, Support (tickets and messages), Ad Reports, Account.

Later modules from the prototype: leads, onboarding, tasks, website builds, social calendar, citations, SEO tracking, SOPs, payments.

## 7. Error handling and safety

- Zod at every boundary. Env validated at boot; the process refuses to start without `DATABASE_URL` and `BETTER_AUTH_SECRET`.
- Every pg-boss job is idempotent by `(job name, natural key)`; retries with backoff, dead-letter after 5.
- Agent runs fail closed: any thrown error marks the run `failed` with the error recorded; nothing outward-facing is sent.
- Claude `stop_reason: "refusal"` is recorded as a failed run with `error = "refusal"`, visible in Agent Runs for a human to pick up. Automatic escalation to a ticket arrives in Plan 2.
- Webhooks verify a shared secret or provider signature before enqueueing.
- Client portal queries always include `client_id` from the session, never from the URL alone.

## 8. Testing

- Vitest unit tests for `core` services and the kernel (fake LLM, mock tools) against docker Postgres, each test in a transaction rolled back.
- Integration test per agent: seed → trigger → assert rows in `agent_runs`, `agent_steps`, `tickets`, `approvals`.
- Playwright: sign in as owner, see incidents; sign in as client, see only own tickets.
- 80 percent coverage target on `core` and `agents`.

## 9. Delivery order

1. **Plan 1** Foundation + Hosting Guard-Dog vertical slice: monorepo, db, core, kernel, worker, minimal admin screens, Coolify deploy.
2. **Plan 2** Inbox + tickets + email channel + Support Triage agent + client portal support.
3. **Plan 3** Ad accounts, metric ingestion (mock), Ad Sentinel, client ad reports.
4. **Plan 4** Port remaining prototype modules; WhatsApp adapter.
