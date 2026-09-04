# Module Map

## Admin portal `apps/web/src/app/(admin)`

Routes match `NAV_GROUPS` in `apps/web/src/lib/nav.ts`. Every module in the spec has landed, so every nav entry is a link to a route that exists — the disabled "arrives in Plan N" labels the earlier plans rendered are gone. `/account` is deliberately not in the nav: it is reached from the member's own identity block in the sidebar.

| Route | Module | Plan | Reads | Writes |
|---|---|---|---|---|
| `/` | Dashboard | 1 | open incidents, pending approvals, open tickets | — |
| `/clients`, `/clients/[id]` | Clients | 2 | clients, contacts, billing profile, sites, domains, activity events | create/update/archive client, contacts, billing profile, sites, domains |
| `/clients/[id]/support` | Client support tab | 4 | that client's conversations and cases | — (replies happen on the thread) |
| `/clients/[id]/portal-users` | Client portal users tab | 4 | `client_users` joined to `user` | invite a portal user (one-time password shown once), suspend / reactivate |
| `/websites`, `/websites/[id]` | Websites | 2 | sites, domains, monitors, incidents | — (a site is created on the client page) |
| `/domains`, `/domains/[id]` | Domains | 2 | domains, dns records, sites | attach/detach a domain to a site, edit domain, dns record CRUD (a domain is created on the client page) |
| `/tasks`, `/tasks/[id]` | Tasks | 3 | tasks, clients, members, comments | create, status, assign, comment, checklist, visibility |
| `/clients/[id]/tasks` | Client tasks tab | 3 | tasks for one client, phase progress | status, visibility, regenerate onboarding |
| `/settings/packages` | Packages | 3 | packages | create, edit, archive |
| `/settings/task-templates` | Task templates | 3 | task_templates, packages | create, edit, reorder, delete |
| `/inbox`, `/inbox/[conversationId]` | Inbox | 4 | conversations, messages, clients, linked ticket | staff reply (queued outbound email), internal note |
| `/cases`, `/cases/[id]` | Open Cases | 1 (list), 4 (full) | tickets, conversation messages, ticket_events, linked tasks, members | status, assign, escalate, internal note, run Support Triage |
| `/tickets` | Open Cases (legacy) | 1 | — | redirects to `/cases` |
| `/incidents`, `/incidents/[id]` | Incidents | 1 | incidents, checks, agent run | acknowledge, resolve |
| `/invoices`, `/invoices/[id]`, `/invoices/[id]/print` | Invoices | 5 | invoices, their lines, the client and the supplier organisation | raise an invoice from a subscription, mark paid, void, request an approval to send, send an approved one |
| `/payments` | Payments | 5 | payments joined to their invoice, unpaid invoices | record a manual payment against an invoice |
| `/ads`, `/ads/[accountId]` | Ads | 5 | ad accounts, daily snapshots and the computed ROAS/CPC signals | add an ad account |
| `/ads/reports` | Ad reports | 5 | agent-drafted ad reports | approve a draft, send an approved one to the client |
| `/reports`, `/reports/[id]` | Client reports | 5 | monthly client reports | publish a report to the client portal |
| `/settings/billing` | Billing settings | 5 | which payment and ads credentials are configured, and the VAT rate — each rendered as "Set" / "Not set", never its value | — |
| `/approvals` | Approvals | 1 (decision), 4 (resume) | approvals with their agent run | approve/reject, queueing `agent.resume` so the kernel runs the tool and stamps the row |
| `/settings/agents` | Agents | 1 | agent_enablement | toggle |
| `/knowledge`, `/knowledge/new`, `/knowledge/[id]` | Knowledge Base | 4 | knowledge_articles, full-text search over them | create, edit, publish/unpublish, delete |
| `/settings/email` | Email | 4 | `email_identities` per client, plus the configured domain, provider, adapter and `MAIL_FROM`. A secret is rendered as "Set" / "Not set", never its value | send a test email through the configured adapter |
| `/team` | Team | 2 | organisation members + users | create member (one-time password), deactivate |
| `/account` | Account | 2 | the signed-in member's own row | change your own password (Better Auth), which stamps `organisation_members.initial_password_set_at` and closes the re-issue window on `/team` |
| `/settings/organisation` | Organisation | 2 | organisation, SUPPORT_EMAIL_DOMAIN | — |
| `/api/search` | Global search | 2 | clients, sites, domains, tickets | — |
| `/api/webhooks/email/inbound` | Inbound email | 4 | `email_identities` (to resolve the organisation), `organisations` | none — validates the shared secret, normalises by provider, writes attachments to `STORAGE_DIR` and enqueues `inbound.message` |
| `/api/attachments/[org]/[file]` | Attachment download | 4 | files under `STORAGE_DIR` | — (admin session required; refuses any organisation but the caller's) |
| `/agents/runs/[id]` | Agent run trace | 1 | one `agent_runs` row with its `agent_steps`, the approvals it raised and token usage | — (read-only; decisions happen on `/approvals`) |
| `/clients/[id]/invoices` | Client invoices tab | 5 | that client's invoices | — (an invoice is raised on `/invoices`) |
| `/clients/[id]/reports` | Client reports tab | 5 | that client's monthly reports | — (publishing happens on `/reports`) |
| `/api/health` | Health check | 1 | — | — (`{"ok":true}`; Coolify's health check path for the web resource) |
| `/api/auth/[...all]` | Better Auth | 1 | Better Auth's own tables | sign-in, sign-out, password change. Self-registration is disabled (`emailAndPassword.disableSignUp`) |
| `/api/webhooks/stripe` | Stripe webhook | 5 | invoices, payments | applies a signature-verified Stripe event. It verifies against `STRIPE_WEBHOOK_SECRET` and fails closed — a 503 unless the real adapter is configured, so it can never accept a mock-signed event |

Two routes sit outside both groups, because they run before the shell is chosen: `/sign-in` (the one sign-in page for staff and clients alike — there is no sign-up) and `/after-sign-in`, which reads the session Better Auth just set and sends an admin to `/` and a client user to `/portal`.

## Core services `packages/core/src`

The Plan 2 folders and what each exports. Every function has the shape `(db, organisationId, input)`.

| Folder | Exports |
|---|---|
| `activity` | `recordActivity`, `listActivity` |
| `notifications` | `notify`, `notifyOwner`, `listNotifications`, `countUnreadNotifications`, `markNotificationRead`, `markAllNotificationsRead` |
| `clients` | `createClient`, `updateClient`, `archiveClient`, `listClients`, `getClient`, `escapeLike`, `slugify`, `uniqueClientSlug`, `createContact`, `updateContact`, `deleteContact`, `listContacts` |
| `billing` | `upsertBillingProfile`, `getBillingProfile` |
| `sites` | `createSite`, `updateSite`, `listSites`, `getSite` |
| `domains` | `createDomain`, `updateDomain`, `deleteDomain`, `listDomains`, `getDomain`, `createDnsRecord`, `updateDnsRecord`, `deleteDnsRecord`, `listDnsRecords` |
| `team` | `createMember`, `listMembers`, `countActiveOwners`, `deactivateMember`, `generateOneTimePassword`, `reissueOneTimePassword`, `recordOwnPasswordChange` |
| `search` | `search` — one query across clients, sites, domains and tickets |
| `email` | `ensureEmailIdentity`, `supportAddress` — the routable inbox behind `clients.support_email` |
| `support` | `createTicket`, `ingestInboundEmail`, `updateTicket`, `assignTicket`, `escalateTicket`, `replyToConversation`, `replyAsClient`, `sendQueuedMessage`, `slaDueAt`. `replyAsClient` is the portal reply path: it writes a client's portal reply the way `ingestInboundEmail` writes their email — `direction: "inbound"`, `author_kind: "client"` — and reopens the case |
| `knowledge` | `createKnowledgeArticle`, `updateKnowledgeArticle`, `deleteKnowledgeArticle`, `listKnowledgeArticles`, `searchKnowledge` |
| `client-users` | `createClientUser`, `listClientUsers`, `setClientUserStatus` |
| `approvals` | `decideApproval` |

Supporting folders from Plan 1 and Plan 3: `tenancy` (`assertOwned` and friends), `audit` (`recordAudit`), `events` (`emit`, `setEnqueue`), `config` (`supportEmailDomain`, `supportEmailFor`), `queue` (queue names and policies, applied by both processes), `monitoring`, `incidents`, `packages`, `tasks`. Plan 5 adds `billing`, `ads` and `reports`.

## Packages

| Package | What is in it |
|---|---|
| `packages/db` | Drizzle schema, migrations, the client, and the idempotent dev seed |
| `packages/core` | Domain services, one folder per domain, all `(db, organisationId, input)` |
| `packages/agents` | The kernel (`run-agent`, `resume-agent`, the shared `run-loop`, policy gate, recorder), the tools and the three agents |
| `packages/channels` | Comms adapters: the `EmailAdapter` interface with mock and SMTP implementations, the inbound normalisers (`normalizePostmark` / `normalizeCloudflare` / `normalizeGeneric`) and attachment storage |
| `packages/integrations` | External providers — Coolify, Cloudflare DNS, Google Ads, Meta Ads, Stripe, the uptime probe — each an interface plus a mock. A real client is written for **Stripe and the HTTP uptime probe only**, and env chooses it; ads, hosting, DNS and CMS are mock-only so far, which `resolveAdapters` records as `hasRealImplementation: false` |
| `packages/config` | Shared tsconfig / eslint / prettier |
| `packages/ui` | **Reserved, not built.** A `README.md` and nothing else — no `package.json`, so pnpm does not treat it as a workspace member. Shared components live in `apps/web/src/components` until there is a second consumer |

## Client portal `apps/web/src/app/(portal)`

| Route | Module | Plan | Scope |
|---|---|---|---|
| `/portal` | Home | 4 | their own sites' status, open cases, latest activity |
| `/portal/sites` | Websites | 4 | their sites with the current uptime state |
| `/portal/domains` | Domains | 4 | their domains and expiry |
| `/portal/tasks` | Progress | 4 | their tasks marked `client_visible` |
| `/portal/support` | Support | 4 | their own `client_visible` cases only |
| `/portal/support/new` | New request | 4 | raises a case on their client; severity cannot be set to `critical` |
| `/portal/support/[id]` | Case thread | 4 | one case of theirs; internal notes are filtered out of the thread. A reply is written the way `ingestInboundEmail` writes a client email — `direction: "inbound"`, `author_kind: "client"` — so the Inbox's "needs reply" badge (`lastDirection === "inbound"`) lights up for staff. It never leaves LaunchOS as email: a client does not need their own words posted back to them |
| `/portal/invoices`, `/portal/invoices/[id]` | Invoices | 5 | their invoices, excluding drafts |
| `/portal/reports`, `/portal/reports/[id]` | Reports | 5 | published reports only |
| `/portal/account` | Account | 4 | their profile and a password change |

Every portal query takes `clientId` from the session (`apps/web/src/lib/portal-session.ts`); there is no path from the URL into it. Another client's id is a 404, not somebody else's data, and an `(admin)` route requested from a portal session bounces back to `/portal`. `/after-sign-in` is what decides between the two shells after Better Auth sets the cookie.

## Later

Leads, website builds, social calendar, citations, SEO tracking and SOPs. Each becomes a folder in `packages/core` plus a route group module, on the same tenancy and audit rules.
