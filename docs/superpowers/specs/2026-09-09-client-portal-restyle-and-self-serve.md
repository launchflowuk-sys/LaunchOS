# Client portal: the shared design, and buying a service without asking

**Date:** 2026-09-09
**Status:** approved, building
**Design source:** `docs/CLIENT PORTAL.png` — the picture is the specification for Phase 1.

Two pieces, deliberately sequenced. Phase 1 makes the portal look like the
picture. Phase 2 adds a way for a client to buy more from us, built in the
language Phase 1 establishes so the new screens are right the first time.

---

## Phase 1 — the portal looks like the picture

### Why first

Every screen Phase 2 adds is a portal screen. Building them before the shell
exists means building them twice. The routes themselves already map almost
one-to-one onto the nav in the picture, so this is a restyle, not a
re-architecture:

| Picture | Route today |
|---|---|
| Overview | `/portal` |
| Websites | `/portal/sites` |
| Domains | `/portal/domains` |
| Progress | `/portal/tasks` |
| Content | `/portal/content` |
| Documents | `/portal/documents` |
| Proposals | `/portal/proposals` |
| Invoices | `/portal/invoices` |
| Plan | `/portal/plan` |
| Support | `/portal/support` |
| Reports | `/portal/reports` |

### The shell

- **Sidebar**, 260px, white. LaunchFlow logo above a `CLIENT PORTAL` wordmark.
  Items in labelled groups — `YOUR WEBSITES`, `YOUR PROJECTS`, `BILLING`,
  `HELP & INSIGHTS` — as small uppercase letterspaced grey labels. The active
  item is a solid blue rounded pill with white text. A tinted "Need a hand? /
  Talk to LaunchFlow" card sits at the bottom.
- **Top bar**: business avatar (initials) with a `YOUR BUSINESS` eyebrow and
  the business name; a pill search in the centre; the notifications bell; an
  account button opening a menu of Personal details, Company details, Billing
  & plan, Security, and Sign out in red.

### Overview

Blue letterspaced eyebrow, a large `Hello, <first name>.`, a one-line
subtitle, a green-dot status line, then a primary **New request** and an
outline **Book a call**.

Three **dark navy** stat cards — translucent icon circle, label, large
number, footer line with a coloured dot. Then two columns: white "Your
websites" and "Open requests" cards on the left; a **blue gradient promo
card** on the right with a white CTA.

**The dark cards and the gradient card are portal-only.** The admin
workspace stays light — that rule is unchanged and must not be carried across
by the shared components.

### Components

Extract to `apps/web/src/app/(portal)/_components/`, not to `packages/ui` —
there is no second consumer yet, and CLAUDE.md keeps shared components in the
app until there is.

`PortalStatCard` (dark), `PortalPanel` (white card with title and a "View all"
affordance), `PortalPromoCard` (gradient), `PortalEmptyState`, `StatusPill`.

Tokens and geometry come from the `launchflow-design` skill; only genuinely
new portal-specific values are added.

---

## Phase 2 — a client buys a service without asking

### The decisions behind it

| Decision | Chosen |
|---|---|
| Approval | **Split.** Catalogue items with a price buy instantly. Bespoke work collects a brief instead. |
| Catalogue | **Extend `packages`.** No second products table. |
| Stacking | **Everything stacks.** A second retainer is a second subscription — with a warning at the point of purchase. |
| Bespoke lands as | **A lead**, `source: "portal"`, with the client linked. |
| Trials | **Per package, off by default.** `trialing` counts as confirmed and starts onboarding. |

### Catalogue

`packages` gains three columns:

- `kind` — `retainer` | `one_off` | `addon`, default `retainer`, so every
  existing row is unchanged by the migration.
- `self_serve` — boolean, **default false**. Nothing becomes buyable by
  accident.
- `trial_days` — integer, default 0. Zero means pay now.

A one-off is `monthly_price_pence = 0` with a `setup_price_pence`. Checkout
opens in `payment` mode for those and `subscription` mode for retainers —
the branch `apps/worker/src/jobs/proposals-accepted.ts` already makes.

An offering appears in the portal only when
`active && self_serve && stripe_price_id IS NOT NULL`. No price, no
self-serve: that is the safety catch, and it is why the flag defaults false.

### Three doors from `/portal/services`

Nav entry **Add a service** under `BILLING`, below Plan. The Overview promo
card may also point at it.

1. **Buy** — catalogue → detail and setup questions → Stripe → confirmation.
2. **Stack warning** — a client holding a live retainer who buys another
   retainer sees an interstitial naming their current plan and its price, and
   saying plainly that this adds a second monthly charge. Two ways on: **Add
   anyway** and **Change my plan instead** (the existing request flow).
3. **Bespoke** — a brief form creating `createLead(source: "portal")` with the
   client in metadata, and a notification for the owner.

### Payment and onboarding

A `portal_purchases` row is written **before** Stripe — status `pending`,
unique on `stripe_session_id` — so the return trip is idempotent and abandoned
checkouts are visible.

`completePortalPurchase` follows `completeProposalCheckout` exactly: check the
marker, check tenancy, refuse anything not actually paid, claim the work once,
link the customer, record the subscription, stamp the source row.
`webhook-sync.ts` gains a third marker branch beside `signup` and `proposal`.

On `paid` or `trialing`: `createProject` (its `proposalId` is optional, so a
purchase can drive it directly) and the onboarding tasks — the same two calls
the accepted-proposal job makes.

### The onboarding hazard, and the fix

`generateOnboardingTasks(db, organisationId, clientId)` reads its templates
from `client.packageId` and dedupes by `template_id` **per client**. With
stacking, a client buying a second package would get the *first* package's
templates, nearly all skipped as already generated — the feature would appear
to do nothing at all.

So Phase 2 adds a variant taking an explicit `packageId` and scoping the
dedupe to the new project rather than the client. The proposal flow uses this
function too, so its existing behaviour gets characterisation tests **before**
the change.

---

## Testing

Vitest against the docker Postgres:

- catalogue filtering — a package without a Stripe price is never offered
- the stack-warning rule
- completion idempotency — replay one session twice, expect one project
- the trial path — `trialing` starts onboarding
- bespoke brief creates a lead with `source: "portal"`
- onboarding templates resolve from the **purchased** package, not the client's

Plus `portal-purchase.demo.test.ts`, narrating the chain end to end in the
style of `lead-to-delivery.demo.test.ts`.

Playwright covers the portal shell against the picture: nav groups, the active
pill, the account menu, and the Overview at mobile width.

---

## Out of scope

Admin-side catalogue editing beyond the three new fields on the existing
Packages screen. Invoicing changes. Any change to the admin workspace's
appearance.
