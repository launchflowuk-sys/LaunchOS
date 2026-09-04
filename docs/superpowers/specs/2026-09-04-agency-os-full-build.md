# LaunchOS Full Build — Plans 2 to 5 Design Spec

Date: 2026-09-04. Status: authorised by Shoji ("finish everything; only env vars or external dependencies may remain as blockers"). Builds on the Plan 1 foundation described in `2026-09-03-agency-os-design.md`; where the two differ, this document wins.

## 0. Shoji's requirement, in his words, structured

1. **Client data system.** Add a client with name, email, phone, address, financial details, and the domain names bought for or assigned to them (many per client). Websites belong to clients.
2. **Zero-to-handover workflow.** Adding a client generates the list of tasks for that client's package: website build, deployment, SEO setup, handover, then ongoing support. Shoji or a team member marks them complete.
3. **Recurring service work per package** that justifies the monthly retainer: Facebook posts, blog posts, Google Business Profile updates, SEO tasks. Generated on a schedule, tracked, and visible to the client.
4. **Left-hand navigation:** Clients, Websites, Domains, Tasks, Payments, Invoices, Open Cases (support), plus the existing Incidents, Approvals, Agents, Settings.
5. **One support email address per client.** Mail to that address is picked up, analysed by AI, turned into a ticket and tasks, and assigned to a team member; Shoji is informed. Everything manageable remotely.
6. **A team** Shoji can add members to and assign work to while abroad.
7. **Client portal** so clients see progress, sites, domains, invoices, and raise support requests.
8. Packages: web apps with dashboards, or websites, with or without ad management; ad management is the lowest priority.

## 1. Plans and order

| Plan | Scope | Branch merges into main when its final review is clean |
|---|---|---|
| **P2 Client system + team** | Clients CRUD with contacts, address, billing profile, notes; sites and domains CRUD with DNS records; team members (invite = admin-created account with one-time password), assignment-ready; nav rebuilt; global search box. | yes |
| **P3 Task engine** | Packages and service catalogue; task templates (onboarding blueprints and recurring service items); tasks with statuses, assignee, due dates, comments, checklists; automatic generation on client creation and on schedule; Tasks board and list; per-client and per-site task views; client-visible progress. | yes |
| **P4 Support intake + client portal + Support Triage** | Per-client support email address; inbound email webhook adapters; unified inbox; tickets with threads and internal notes; outbound email via SMTP with approval; Support Triage agent; approval resume (`agent.resume`); notifications to Shoji; client portal (sites, domains, tasks progress, tickets, invoices, account); client users. | yes |
| **P5 Payments, invoices, ads, reporting** | Stripe adapter (mock when unset) for subscriptions per package; invoices and payments records; overdue detection creating tickets; ad accounts and metric snapshots (mock ingest); Ad Performance Sentinel agent; monthly client report page. | yes |

Each plan ships with: migrations, core services with tests, admin screens, Playwright smoke for its main flow, docs updates (`MODULE_MAP.md`, `DATA_MODEL.md`, `AGENT_FRAMEWORK.md` where relevant), and the README status section refreshed.

## 2. Cross-cutting rules (apply to every plan)

- Everything in `CLAUDE.md` still binds: tenancy, approval gate, audit log, mock-first integrations, secrets in env, immutability, file size.
- **Ownership assertions.** Any service that takes a foreign id (clientId, siteId, taskId, ticketId, invoiceId…) asserts it belongs to `organisationId` via `packages/core/src/tenancy/assert-owned.ts` (extend it with `assertOwned(db, organisationId, table, id)` generic helper).
- **Transactions.** Multi-write services run inside `db.transaction`; domain events emit after commit.
- **Domain events.** Extend `DomainEvent` in `packages/core/src/events/emit.ts`. The worker maps events to jobs; the web process sets an enqueue function too (`apps/web/src/lib/queue.ts`, a thin pg-boss `send` client) so web-originated events are not dropped.
- **Notifications.** New table `notifications (user_id, kind, title, body, link, read_at)`. Owner is notified in-app for: new ticket, escalation, approval requested, task overdue, payment failed, site down. Email notification to the owner via the outbound email adapter when `OWNER_NOTIFY_EMAIL` is set.
- **Financial details.** Never store card numbers or bank details. `billing_profiles` stores billing name, address, VAT number, payment terms, Stripe customer id, preferred method label. That is the whole "financial details" surface.
- **UI.** shadcn, white/light, dense but calm tables, a left sidebar with grouped sections, page header with primary action, empty states with a call to action, toasts on actions, forms validated with Zod on both sides (react-hook-form + zod on the client; server action re-validates). Mobile-usable: sidebar collapses to a sheet under 1024px. Footer "Powered by LaunchFlow".
- **Search.** Global search input in the header hits `/api/search?q=` returning clients, sites, domains, tickets, tasks (name/subject ILIKE, org-scoped).
- **Client portal scoping.** Every portal query takes `clientId` from the session's `client_users` row. A client user can belong to one client in v1.
- **Tests.** Vitest on every core service with real Postgres (rolled back); agent tests with the fake LLM; Playwright smoke per plan (admin sign-in → main flow). Test data uses random slugs and emails.
- **Seed.** Extend the seed with two packages, templates, one team member, one client user, sample tasks, one support conversation, one invoice.

## 3. Data model additions (exact names; each plan adds its own migration)

### P2
- `billing_profiles` (client_id unique, billing_name, address_line1, address_line2, city, postcode, country default 'GB', vat_number, payment_terms_days int default 14, stripe_customer_id, preferred_method text, notes).
- `clients` add: `slug` unique per org (used for the support address), `address_line1/2`, `city`, `postcode`, `country`, `website_url`, `industry`, `support_email` (generated, unique), `package_id` nullable (FK added in P3).
- `domains` add: `client_id` (a domain can exist before a site), `dns_provider` enum `cloudflare|registrar|other`, `nameservers text[]`, `notes`; `site_id` becomes nullable.
- `organisation_members` add: `display_name`, `title`, `phone`, `invited_by`, `initial_password_set_at`.
- `client_users` add FK to clients (deferred from Plan 1).
- `notifications` as above.
- `activity_events` (organisation_id, client_id?, site_id?, actor_kind, actor_id?, kind, title, body?, link?) — the per-client timeline.

### P3
- `packages` (name, slug, description, monthly_price_pence, setup_price_pence, currency 'GBP', includes jsonb: `{ website: bool, seo: bool, ads: bool, social_posts_per_month: int, blog_posts_per_month: int, gbp_updates_per_month: int }`, active).
- `task_templates` (package_id nullable = applies to all, phase enum `onboarding|recurring|support`, kind enum `build|deploy|dns|seo|content|social|gbp|review|handover|support|billing|other`, title, description_md, offset_days int (onboarding: due = client.created + offset), recurrence enum `none|weekly|monthly|quarterly`, default_assignee_role enum `owner|staff|any`, sort_order, checklist jsonb string[]).
- `tasks` (client_id, site_id?, template_id?, phase, kind, title, description_md, status enum `todo|in_progress|blocked|review|done|cancelled`, priority enum `low|medium|high|urgent`, due_at?, assignee_user_id?, created_by_kind actor_kind, created_by_id?, completed_at?, ticket_id?, recurrence_key? (e.g. `social:2026-10` to make generation idempotent), checklist jsonb `{ label, done }[]`, client_visible bool default true).
- `task_comments` (task_id, author_kind, author_id?, body_md).
- `clients.package_id` FK → packages; `clients.onboarded_at`, `clients.handover_at`.

### P4
- `conversations` add: `ticket_id?`, `external_thread_key` (Message-ID / In-Reply-To chain root), `participant_email`.
- `messages` add: `from_email`, `to_email`, `subject`, `raw_headers jsonb`, `attachments jsonb` (name, size, url; stored under `storage/attachments/<org>/<id>` on local disk, `STORAGE_DIR` env, default `./storage`), `status enum queued|sent|failed|received`.
- `tickets` add: `assignee_user_id`, `first_response_at`, `resolved_at`, `sla_due_at`, `triage jsonb` (agent output: category, severity, summary, suggested_fix, confidence).
- `email_identities` (client_id unique, address unique, display_name, inbound_secret) — the per-client support address.
- `knowledge_articles` (title, slug, body_md, tags text[], published, search tsvector with GIN index).
- `agent_runs.metadata.pending` consumed by `agent.resume`.

### P5
- `subscriptions` (client_id, package_id, stripe_subscription_id?, status enum `trialing|active|past_due|cancelled|paused`, current_period_start/end, amount_pence, currency).
- `invoices` (client_id, subscription_id?, number unique per org `LF-2026-0001`, status enum `draft|sent|paid|overdue|void`, issued_at, due_at, paid_at?, subtotal_pence, vat_pence, total_pence, currency, stripe_invoice_id?, pdf_url?, line_items jsonb).
- `payments` (client_id, invoice_id?, amount_pence, currency, provider enum `stripe|bank|cash|other`, provider_ref?, status enum `pending|succeeded|failed|refunded`, paid_at?).
- `ad_accounts`, `ad_metric_snapshots`, `ad_reports` as in the Plan 1 spec.
- `client_reports` (client_id, period_start, period_end, summary_md, stats jsonb, status draft|published, published_at?).

## 4. Workflows

### Client creation (P2 + P3)
`createClient` → creates client, billing profile (empty), support email identity `<slug>@<SUPPORT_EMAIL_DOMAIN>` (P4 adds the row; P2 stores `support_email` string), activity event → emits `client.created` → worker `tasks.generate-onboarding` creates tasks from templates where `package_id IS NULL OR = client.package_id AND phase = onboarding`, due = now + offset_days, assignee by role (owner → Shoji's user id, any → unassigned). Onboarding complete = all onboarding tasks done → `clients.onboarded_at` set. Handover task done → `clients.handover_at`.

### Recurring service generation (P3)
Cron `tasks.generate-recurring` daily 06:00 Europe/London: for each active client with a package, for each recurring template, create the task for the current period if `recurrence_key` does not exist. Quantities from `packages.includes` (e.g. 4 social posts a month → 4 tasks `social:2026-10:1..4`).

### Support intake (P4)
Inbound webhook `POST /api/webhooks/email/inbound` accepts a normalised payload `{ provider, to, from, subject, text, html, messageId, inReplyTo, references[], attachments[] }`. Adapters normalise: `postmark` (Postmark inbound JSON), `cloudflare` (Email Routing worker forward JSON), `generic`. Auth: `INBOUND_EMAIL_SECRET` header or provider signature. Handler: resolve client by `to` address via `email_identities`, find or create conversation by thread key, append inbound message, create ticket if none open for the conversation, emit `ticket.created` → Support Triage agent. Unknown address → conversation under a "Unmatched inbound" holding client per org (`clients.slug = 'unmatched'`, created by seed) and notify owner.

### Support Triage agent (P4)
Trigger `ticket.created`. Tools: `tickets_get` (safe), `knowledge_search` (safe), `tickets_update` (safe: category, severity, triage json, status triaged), `tasks_create` (safe: creates task linked to ticket, assignee by role), `tickets_assign` (safe: picks least-loaded staff), `tickets_escalate` (safe: marks escalated + notifies owner), `messages_reply_to_client` (requires_approval), `dns_update_record` (requires_approval, mock Cloudflare), `cms_update_content` (requires_approval, mock). Prompt: classify, search KB, decide fix vs escalate, draft reply. Output summary stored in `tickets.triage`.

### Approval resume (P4)
Approve → `agent.resume {runId, approvalId}`: load `metadata.pending`, execute the awaiting tool, append its result plus `completedResults` and any `remainingToolUseIds` as `is_error` "skipped pending approval" results, continue the loop. Reject → resume with a tool_result "rejected by human: <note>".

### Outbound email (P4)
`packages/channels/src/email`: `EmailAdapter { send(msg) }` with `SmtpEmailAdapter` (nodemailer, env SMTP_*) and `MockEmailAdapter` (records to `messages` with status sent). Sending to a client is always via approval unless a staff user sends manually from the inbox (human action, audited). Owner notifications bypass approval.

### Payments (P5)
`PaymentsAdapter { createCustomer, createSubscription, cancelSubscription, listInvoices, webhookVerify }` with `StripePaymentsAdapter` (env STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) and `MockPaymentsAdapter`. Webhook `POST /api/webhooks/stripe` → invoices/payments rows. Cron daily: invoices past due → status overdue → ticket (category billing) + owner notification. Invoice HTML page in portal; "Send invoice" is an approval that emails the portal link.

### Ads (P5)
Mock ingest cron daily creates plausible `ad_metric_snapshots` for seeded ad accounts (deterministic pseudo-random by date). Ad Sentinel per Plan 1 spec; reports draft; "Send report" approval emails the portal link. Real Google/Meta adapters are interfaces with TODO-free mock implementations; real ones require external credentials (blocker to report).

### Client portal (P4, extended P5)
`/portal` home (site status, open tickets, upcoming tasks, latest invoice), `/portal/sites`, `/portal/domains`, `/portal/tasks` (client-visible tasks with progress bar per phase), `/portal/support` (list, new ticket form, thread reply), `/portal/invoices` (P5), `/portal/reports` (P5), `/portal/account` (contacts, change password). Client users are created by admin from the client page ("Invite user": creates Better Auth user with a generated one-time password shown once; sign-up stays disabled).

## 5. Admin navigation (final)

Dashboard · Clients · Websites · Domains · Tasks · Inbox · Open Cases (tickets) · Incidents · Payments · Invoices · Ads · Approvals · Agents · Knowledge Base · Team · Settings.

Client detail page tabs: Overview (timeline), Contacts & Billing, Sites & Domains, Tasks, Support, Invoices, Reports, Portal users.

## 6. Environment variables added

`SUPPORT_EMAIL_DOMAIN` (e.g. `support.launchflow.co.uk`), `INBOUND_EMAIL_PROVIDER=generic|postmark|cloudflare`, `INBOUND_EMAIL_SECRET`, `SMTP_*` (existing), `MAIL_FROM`, `OWNER_NOTIFY_EMAIL`, `STORAGE_DIR`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `EMAIL_ADAPTER=mock|smtp`, `PAYMENTS_ADAPTER=mock|stripe`, `ADS_ADAPTER=mock`. All documented in `.env.example` and `docs/DEPLOYMENT.md` with which feature each unlocks.

## 7. Acceptance per plan (Playwright + Vitest)

- **P2:** create client with contacts, billing profile, two domains and a site from the UI; appears in search; timeline shows events; add a team member; sidebar shows the new nav.
- **P3:** creating a client with a package generates the onboarding task list; board drag-free status change via buttons; recurring generation job creates monthly social/blog/GBP tasks idempotently; client-visible tasks listed on the client's Tasks tab.
- **P4:** POST a generic inbound email payload to the webhook for a client's support address → conversation, message, ticket, Support Triage run (fake LLM in tests) with a parked reply approval; approve → run resumes and the reply is recorded as sent via the mock adapter; client user signs in and sees only their tickets and can reply.
- **P5:** mock subscription for a client; invoice generated, marked overdue by the cron, ticket raised; ad snapshots ingested, Ad Sentinel flags a drop and drafts a report; client report page renders.

## 8. Known external blockers (report, do not fake)

Anthropic API key; an inbound email provider (Postmark or Cloudflare Email Routing) pointing at the webhook plus DNS for `SUPPORT_EMAIL_DOMAIN`; SMTP credentials; Stripe keys and webhook; Google Ads and Meta credentials; Coolify resources and domain. Everything else must work locally with mocks and the seed.
