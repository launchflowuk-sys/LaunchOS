# Admin alerts, WhatsApp redundancy and the costing system — spec

**Date:** 11 Sep 2026 · **Status:** agreed direction, costing section open for discussion · **Owner:** Shoji

Decisions already taken with Shoji (11 Sep): WhatsApp through **Twilio**; alert on
**new lead/enquiry, brief submitted, new support request, urgent incidents**;
shared costs split **by measured usage**, remainder evenly.

---

## Part 1 — Admin email setting

### Today
Owner emails go to the `OWNER_NOTIFY_EMAIL` env var (brief-submitted email,
Ops Brief, Settings → Email test). The bell (`notifyOwner`) never emails.

### Build
- Stored in `organisations.metadata.notifications` (the existing pattern:
  `assignment`, `booking`):

  ```ts
  { adminEmails: string[]        // first is the main address
    whatsappNumbers: string[]    // E.164, e.g. +447700900123
    whatsappEnabled: boolean }
  ```
- Core: `getNotificationSettings`, `setNotificationSettings` (Zod-validated,
  audited as `organisation.notifications_updated`), and
  `adminEmailRecipients(db, org, env)`, which falls back to `OWNER_NOTIFY_EMAIL`
  until a value is saved, so nothing goes quiet on deploy day.
- Every `OWNER_NOTIFY_EMAIL` reader switches to `adminEmailRecipients`.
- Settings → **Notifications** (Organisation group, `settings` permission):
  admin emails, WhatsApp numbers, a switch, and "Send test email" / "Send test
  WhatsApp" buttons that report the provider's own words.

## Part 2 — Alerts by email **and** WhatsApp

### Today (mapped 11 Sep)
| Group | Event | Bell/push | Email |
|---|---|---|---|
| Lead | `lead.captured`, `lead.created`, `funnel.hot_lead` | yes | no |
| Brief | `brief.submitted` | yes | owner email (web route) |
| Support | inbound email / portal case → `ticket.created` | **no owner alert at all** | no |
| Incident | site down → `openIncident` | **no owner alert at all** | no |
| Incident | `payment.failed`, `worker.down`, `system.error` | yes | no |

`worker.down` is only checked when somebody loads an admin page. With nobody
in the app, a dead worker says nothing.

### Build
- Core `alertAdmins(db, org, { group, kind, title, body, link, dedupeKey })`:
  writes the bell (as now), then queues `alert.deliver` on pg-boss. The worker
  sends the email and the WhatsApp message, so a slow provider never slows a
  customer's form submission, and a failed send retries.
- Raised from: lead capture, brief submitted, ticket created (new), incident
  opened (new), payment failed, worker down, system error.
- **Dedupe and throttle:** one delivery per `dedupeKey`; at most 20 WhatsApp
  alerts an hour per organisation, then a single "and N more" summary. The same
  rule that stopped the brief writer ringing 109 times in a day.
- **WhatsApp adapter** (`packages/channels`): extends the Twilio SMS adapter.
  `whatsapp:+44…` numbers, message sent from an approved **Content Template**
  (`ContentSid` + `ContentVariables`), because WhatsApp refuses a business
  message outside a 24-hour reply window without one. Mock-first; env selects
  the real one:
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`,
  `TWILIO_WHATSAPP_ALERT_TEMPLATE_SID`, optional `TWILIO_SMS_FROM` (SMS fallback
  when WhatsApp fails).
- Template (utility category), one for everything:
  `LaunchOS alert: {{1}}. {{2}} Open: {{3}}`

### Needed from Shoji
1. A Twilio account, and a **second** number as the WhatsApp sender. Never the
   existing WhatsApp Business number (see the pricing spec, 7 Sep).
2. Approve the template in Twilio (usually within a day).
3. The number(s) alerts go to.

### Open question
Worker-down redundancy. The worker cannot report its own death. The honest fix is
an outside check. A cron on the Hetzner box calls a web endpoint every 5
minutes, and the web side alerts when the worker heartbeat is stale. Shoji to
confirm.

---

## Part 3 — Costing: what LaunchFlow costs, per client and overall

**Goal.** Know, per client and for the company, monthly and yearly:
revenue, direct cost, share of running cost, and margin, as close to live as
the data allows.

### Three ledgers

**1. Cost register: fixed and subscription costs.** One row per thing we pay for.
Generalises `supplier_costs`, which today is Hostinger-only.

| Field | Example |
|---|---|
| supplier | Hetzner, Anthropic, OpenAI, Google Cloud, Mapbox, ScreenshotOne, Postmark, Twilio, Hostinger, GitHub, Apple, Expo |
| business | LaunchFlow · Cabio · Grays CabLine · shared |
| billing | monthly / yearly / per-unit |
| amount + currency | native currency, never pre-converted |
| renews on | date |
| attribution | a client (a domain), usage-based, or shared |

Mapbox is Cabio's, not LaunchFlow's. `business` keeps it off LaunchFlow's P&L.

**2. Usage ledger: every paid call, as it happens.** A new `usage_events` table:
`organisation_id, client_id (nullable), provider, product, quantity, unit,
unit_price, cost_pence, source (agent_run / job / brief / site_build), occurred_at`.

Priced from a **rate card** (a table, editable in Settings, with effective dates)
so a price change does not rewrite history.

What gets metered, from what LaunchOS already automates:

| Automation | Provider | Unit | Where it is recorded |
|---|---|---|---|
| Agents: Content Writer, Brief Writer, Support Triage, Ad Sentinel, Ops Brief, Lead Qualifier, Case Study, weekly updates | Anthropic `claude-opus-5` | tokens in / out | `agent_runs.tokens_in/out` already exist; add the cost |
| Website brief writer | OpenAI `gpt-6-astra` | tokens | `usage` from the response |
| Site generation | OpenAI `gpt-6-astra` | tokens | `usage` from the response |
| Post images | OpenAI `gpt-image-1` | images by size | `image-budget` already estimates pence |
| Site screenshots | ScreenshotOne | captures | per capture |
| Email | Postmark | emails | per send |
| WhatsApp / SMS | Twilio | messages | per send |
| Domains and hosting | Hostinger | per term | existing sync |
| Card fees | Stripe | % + fixed | balance transactions |

**3. Revenue.** Already known: subscriptions, invoices, payments, portal purchases.

### The calculation
- **Client cost** = direct costs (their domains, their hosting) + their metered
  usage + a share of the remaining running costs.
- **Share** = the client's usage as a share of all metered usage that month. The
  unmetered remainder (servers, GitHub) is split evenly across active clients.
- **Margin** = revenue collected − client cost.
- **Company** = MRR / ARR, total monthly and yearly running cost (register
  normalised to both), profit, and next-12-months renewals from renewal dates.
- **Currency** = GBP for reporting; each day's USD→GBP rate stored once, so a
  past month always reads the same.

### Screens
- **Finance → Profit.** Company month and year: revenue, costs by supplier,
  profit, run-rate, renewals due.
- **Client → Profit tab.** Revenue, direct cost, usage cost (by automation),
  shared share, margin, month and year.
- **Settings → Costs.** The register and the rate card.

### Reconciliation
Metered cost is an estimate until the bill arrives. Where a provider has a usage
API (OpenAI, Anthropic admin keys; Postmark; ScreenshotOne), a monthly job
compares metered against billed and shows the gap. Any gap over 10% is flagged.

### Needed from Shoji before building
1. Every subscription with its price, billing period and business. I'll pre-fill
   the register with what the code knows; Shoji corrects the numbers.
2. Admin (usage) API keys for OpenAI and Anthropic, if reconciliation is wanted.
3. VAT: report costs and revenue ex-VAT (recommended) or inc-VAT?

### Build order
1. Admin email setting (small).
2. Alert fan-out + WhatsApp adapter (mock-first; live once Twilio is set up).
3. Usage ledger + rate card, metering agents and OpenAI calls first (they are the variable cost).
4. Cost register (generalise `supplier_costs`) + Stripe fees.
5. Profit screens.
6. Reconciliation.
