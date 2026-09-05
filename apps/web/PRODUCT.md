# LaunchOS — product truth

LaunchOS is the operating system of LaunchFlow, a UK web agency run by Shoji: hosting, website builds, SEO and content retainers, ad management, and client support. One organisation today; built to be sold as multi-tenant SaaS later.

## Who uses it

- **Owner (Shoji)** — runs several businesses, works from a phone as often as a desk, wants to see what needs him and act in one tap. Every screen must work at 375px.
- **Staff** — remote team members who pick up tasks and cases assigned to them. They live in Tasks, Inbox and Cases.
- **Clients** — small local businesses (taxi firms, salons, tuition centres). They sign in rarely, on a phone, to check progress, raise a support case, read a report, or pay an invoice. They must never see anything internal.

## What it does

Two surfaces on one app:

1. **Admin portal** (`/`) — Dashboard, Clients (contacts, billing, sites, domains, tasks, support, portal users), Websites, Domains and DNS, Tasks (list + board), Inbox and Open Cases, Incidents, Payments, Invoices, Ads, Reports, Approvals, Agents, Email settings, Knowledge Base, Team, Organisation, Billing settings, Packages, Task templates, Account.
2. **Client portal** (`/portal`) — Overview, Websites, Domains, Progress, Support, Invoices, Reports, Account.

Three AI agents run in the background (Hosting Guard-Dog, Support Triage, Ad Performance Sentinel). Anything that reaches a client, moves money, changes DNS or edits a site stops in **Approvals** for a human. Approvals is therefore the most consequential screen in the product and must read at a glance: what, for whom, sent where.

## The job of each surface

- Admin, Operate mode: the owner scans state and acts. The important states are: needs approval, overdue, unassigned, client waiting, incident open, invoice overdue, send failed. These must be visibly different from calm state.
- Portal, Operate mode: a client understands where things stand and can ask for help. Calm, generous, trustworthy; the client's own name up front; no jargon.

## Constraints

- Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui, lucide icons. No new UI frameworks.
- White/light professional aesthetic (Shoji's standing preference). No dark decorative themes; a dark sidebar is fine.
- "Powered by LaunchFlow" in the footer of both surfaces.
- Printable invoice and report documents must stay clean of shell chrome.
- All copy is UK English.
