# Module Map

## Admin portal `apps/web/src/app/(admin)`

Routes match `NAV_GROUPS` in `apps/web/src/lib/nav.ts`. Modules whose plan has not landed render as disabled navigation labels rather than links to a 404.

| Route | Module | Plan | Reads | Writes |
|---|---|---|---|---|
| `/` | Dashboard | 1 | open incidents, pending approvals, open tickets | — |
| `/clients`, `/clients/[id]` | Clients | 2 | clients, contacts, billing profile, sites, domains, activity events | create/update/archive client, contacts, billing profile, sites, domains |
| `/websites`, `/websites/[id]` | Websites | 2 | sites, domains, monitors, incidents | — (a site is created on the client page) |
| `/domains`, `/domains/[id]` | Domains | 2 | domains, dns records, sites | attach/detach a domain to a site, edit domain, dns record CRUD (a domain is created on the client page) |
| `/tasks` | Tasks | 3 | — | — |
| `/inbox` | Inbox | 4 | — | — |
| `/tickets` | Open Cases | 1 (list), 4 (full) | tickets | — |
| `/incidents`, `/incidents/[id]` | Incidents | 1 | incidents, checks, agent run | acknowledge, resolve |
| `/payments`, `/invoices`, `/ads` | Money | 5 | — | — |
| `/approvals` | Approvals | 1 | pending approvals | approve/reject |
| `/settings/agents` | Agents | 1 | agent_enablement | toggle |
| `/knowledge` | Knowledge Base | 4 | — | — |
| `/team` | Team | 2 | organisation members + users | create member (one-time password), deactivate |
| `/settings/organisation` | Organisation | 2 | organisation, SUPPORT_EMAIL_DOMAIN | — |
| `/api/search` | Global search | 2 | clients, sites, domains, tickets | — |

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
| `team` | `createMember`, `listMembers`, `countActiveOwners`, `deactivateMember`, `generateOneTimePassword` |
| `search` | `search` — one query across clients, sites, domains and tickets |

Supporting folders from Plan 1 and Plan 3: `tenancy` (`assertOwned` and friends), `audit` (`recordAudit`), `events` (`emit`, `setEnqueue`), `config` (`supportEmailDomain`, `supportEmailFor`), `monitoring`, `incidents`, `support`, `packages`, `tasks`.

## Client portal `apps/web/src/app/(portal)`

| Route | Module | Plan | Scope |
|---|---|---|---|
| `/portal` | Home | 4 | site status summary, open tickets |
| `/portal/sites` | My Sites | 4 | sites, domains, uptime last 30 days |
| `/portal/support`, `/portal/support/[ticketId]` | Support | 4 | own tickets and messages; create ticket; reply |
| `/portal/ads` | Ad Reports | 5 | approved/sent reports only |
| `/portal/account` | Account | 4 | profile, password, contacts |

Every portal query includes `clientId` from the session.

## Later

Leads, website builds, social calendar, citations, SEO tracking and SOPs. Each becomes a folder in `packages/core` plus a route group module, on the same tenancy and audit rules.
