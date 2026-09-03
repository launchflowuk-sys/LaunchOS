# Module Map

## Admin portal `apps/web/src/app/(admin)`

| Route | Module | v1 | Reads | Writes |
|---|---|---|---|---|
| `/` | Dashboard | yes | open incidents, pending approvals, open tickets, flagged ad accounts | — |
| `/clients`, `/clients/[id]` | Clients | yes | clients, contacts, sites, tickets | create/edit client, contacts, invite client user |
| `/sites`, `/sites/[id]` | Sites | yes | site, domains, dns, monitors, incidents | create/edit site, domains, dns (audited) |
| `/inbox`, `/inbox/[conversationId]` | Inbox | plan 2 | conversations, messages | reply (outbound job) |
| `/tickets`, `/tickets/[id]` | Tickets | yes (list), plan 2 (full) | tickets, events, conversation | status, assign, note, escalate |
| `/ads`, `/ads/[accountId]` | Ads | plan 3 | accounts, snapshots, reports | approve/send report |
| `/incidents`, `/incidents/[id]` | Incidents | yes | incidents, checks, agent run | acknowledge, resolve |
| `/approvals` | Approvals | yes | pending approvals with run context | approve/reject → `agent.resume` |
| `/agents`, `/agents/runs/[id]` | Agent Runs | yes | runs, steps | run now |
| `/knowledge`, `/knowledge/[slug]` | Knowledge Base | plan 2 | articles | create/edit/publish |
| `/settings/members` | Members | yes | organisation members | invite, role |
| `/settings/agents` | Agent enablement | yes | agent_enablement | toggle, policy |

## Client portal `apps/web/src/app/(portal)`

| Route | Module | v1 | Scope |
|---|---|---|---|
| `/portal` | Home | yes | site status summary, open tickets |
| `/portal/sites` | My Sites | yes | sites, domains, uptime last 30 days |
| `/portal/support`, `/portal/support/[ticketId]` | Support | plan 2 | own tickets and messages; create ticket; reply |
| `/portal/ads` | Ad Reports | plan 3 | approved/sent reports only |
| `/portal/account` | Account | yes | profile, password, contacts |

Every portal query includes `clientId` from the session.

## Later (from the prototype)

Leads, onboarding, tasks, website builds, social calendar, citations, SEO tracking, SOPs, payments. Each becomes a folder in `packages/core` plus a route group module, on the same tenancy and audit rules.
