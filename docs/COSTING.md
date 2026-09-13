# Costing: the register, and what it does not yet know

What LaunchFlow pays, against what it collects. **Ex-VAT with the gross
alongside**, which is Shoji's call and the right one: VAT charged is not income
and VAT paid is reclaimable, so a margin computed on gross figures is simply
wrong — the gross sits beside it so a number on screen can be matched to the
bank.

Two screens: **Settings → Costs** is the register, **Money → Profit** is the
report.

## The register is one table, not two

`supplier_costs` began as a read-only mirror of Hostinger's API, keyed on an
external id. It is now also the register a person types into, so a row carries:

| Column | Why |
| --- | --- |
| `source` | `sync` or `manual`. Decides what is editable |
| `business` | Which business pays. Mapbox is Cabio's, not LaunchFlow's |
| `vat_treatment` | `standard` / `reverse_charge` / `exempt` / `none` |
| `notes` | What a person needs to remember about the line |
| `external_id` | Now nullable — a typed row has no upstream identity |

Generalised rather than duplicated, as the spec asked. One table means the
Profit screen reads one place, and a cost cannot be double-counted by existing
in both.

**A synced row's money is not editable.** The next sync overwrites it, so
accepting the edit would show a change that silently reverts. Its `business`,
VAT treatment and notes *are* editable — the sync has no opinion on those and
never will. A synced row also cannot be deleted, for the same reason: it would
come straight back.

### VAT treatment is stored, never inferred

A Hetzner invoice under the reverse charge and a Hostinger one carrying UK VAT
are identical as integers. Treating them the same overstates one by a fifth,
which on the server bill is the difference between a real margin and an
imagined one. The same supplier can bill either way depending on the entity, so
it is per row.

The register always stores **net**. Gross is derived, and only `standard` adds
anything.

## Currency: a stored rate per day, or nothing

`fx_rates` holds one rate per day per pair. A cost is converted at the rate for
the first of the month being reported, so **a closed month never changes** —
converting at "today's rate" means last March's profit moves every time
somebody looks at it, which destroys the only thing the figure is for.

**A missing rate is not 1.0.** Rows in a currency with no stored rate are left
out of the totals entirely and the currency is named on both screens. A missing
USD rate treated as parity turns $500 into £500, and the number is plausible
enough that nobody checks it. `convert()` throws rather than guessing.

Rates are entered by hand on the Costs screen — one field per currency that
needs one. No rate provider is wired up; that is a deliberate non-decision
rather than an oversight.

## Prefilling

**Add known suppliers** seeds the register from `KNOWN_SUPPLIERS` — every
provider the code already talks to, priced at **zero**. Zero is honest: the
code knows the supplier exists because a key for it is configured, and knows
nothing about the price. Correcting a list beats remembering one.

Idempotent, matched on supplier and name, so a row that has been renamed or
priced is never touched. The unpriced count is shown on both screens until it
is zero.

## Anthropic: CSV, because the API is gated

The Usage and Cost API needs an **admin key**, and those are only issued to
Team and Enterprise organisations. On an individual account the endpoint does
not exist, so there is nothing to automate against. The Console's CSV export
carries the same figures, and reconciliation is monthly, so a monthly paste is
barely worse than a monthly call.

**`api_key` is the attribution, and that was free.** Each business already has
its own key — `LaunchFlow OS Workspace`, `Agent Zero New`, `NexusEDU`,
`Compliance Data` — so spend splits by business with no tagging. An
unrecognised key is left unattributed rather than guessed into `launchflow`: a
mis-attributed cost is worse than an unattributed one, because nobody goes
looking for a number that already has an owner.

The reader is **read-only and says so**. It summarises and splits; it stores
nothing, because the usage ledger it would write into does not exist. Claiming
to have "imported" would be a lie.

For scale: the whole Anthropic bill for the 30 days to 13 Sep 2026 was
**$14.19** across every business, of which LaunchOS was **$4.73**. Which is why
the register was built before the usage ledger — metering tokens to the penny
is engineering effort spent measuring pocket change, while the subscriptions
are where the money actually is.

## What is not counted, and why the screen says so

The Profit screen carries a permanent, non-dismissible notice listing what is
missing: AI tokens, generated images, website screenshots, email and message
sends, Stripe card fees. `profitReport` returns `complete: false` so no screen
can forget to state it.

A margin that silently omits the variable cost is worse than no margin — it is
a number somebody will quote.

## The usage ledger

`usage_events` records every paid call. Two rules, both so a past month's
figure never moves: **priced at write time** from the rate in force that day,
and **written once** — the idempotency key is built from the thing that
produced the usage, so a pg-boss retry after a commit does not double the
month.

`usage_rates` is effective-dated and `setUsageRate` only ever adds. A
correction is a new rate from today, never an edit to the row that priced
August.

Prices are **micro-pence per unit** because Opus output is 0.0059p a token.
Anything coarser rounds every call to zero and the month comes out far short.

### What is metered, and where

| Meter | Where | Key |
| --- | --- | --- |
| Agent tokens | `run-recorder.addTokens` | `agent_run:<run>:<seq>:<product>` |
| Brief writer | `brief-funnel/write-brief.ts` | `brief:<submission>:v<n>` |
| Site generator | `worker/jobs/site-build-run.ts` | `site_build:<build>` |
| Images | `content/render-image.ts` | `image:<item>` |
| Screenshots | `sites/screenshots.ts` | `screenshot:<site>:<day>` |
| Outbound email | `support/send-queued-message.ts` | `email:<message>` |
| Stripe fees | `costs/stripe-fees.ts`, nightly | `stripe_fee:<txn>` |

`WrittenBrief` and `GeneratedSite` carry a `usage` block. `integrations` stays
a leaf: it reports what the provider said and never prices it, because pricing
needs the rate card that `core` owns.

An unpriced call is recorded at zero with a null `rateId`. Visible and free
beats invisible — `unpricedUsage` names exactly what needs a rate.

## Per-client profit

`clientProfit` answers what a client is worth: revenue collected, their own
register lines, their metered usage, and **their share of shared cost split by
measured usage**. A client generating forty images a month leans on the servers
harder than one with a static page, and an even split would flatter the
expensive one at the cheap one's expense. With nothing metered it falls back to
even, because dividing by zero usage would land the whole server bill on
whoever came first.

## Stripe fees

The one cost that cannot be metered when it happens: Stripe deducts its cut
from the balance rather than putting it on an invoice, so the only honest
source is asking afterwards. `listBalanceTransactions` on the payments adapter,
idempotent on Stripe's own transaction id — the window is a ten-day lookback,
so an overlapping re-run is the normal case rather than the exception.

## Reconciliation

Nightly at 04:20, after the screenshot run so the night's captures are already
in the ledger. Per provider, and **a missing credential reads as
`not_reconciled`, never as a zero gap** — a provider nobody could check must
look unchecked, because reporting a perfect match because we never asked is the
failure worth engineering against.

| Provider | How |
| --- | --- |
| OpenAI | organisation Costs API, `OPENAI_ADMIN_KEY` |
| Anthropic | Console CSV — admin keys are Team/Enterprise only |
| Stripe | nothing to reconcile; the fees *are* Stripe's own figures |

The owner is belled only on a real gap over 10%. A nightly "could not check"
would be noise that teaches him to ignore the bell.

## Still to build

Nothing in the costing system. What would extend it: storing the reconciliation
results so a gap has a history rather than only a notification, and metering
Twilio once WhatsApp is live.

## Files

| Path | What |
| --- | --- |
| `packages/db/src/schema/supplier-costs.ts` | The register, generalised |
| `packages/db/src/schema/fx-rates.ts` | One rate per day |
| `packages/core/src/costs/normalise.ts` | Pure arithmetic — periods, VAT, conversion |
| `packages/core/src/costs/register.ts` | CRUD, prefill, `KNOWN_SUPPLIERS` |
| `packages/core/src/costs/fx.ts` | Rate storage and lookup |
| `packages/core/src/costs/profit.ts` | The report |
| `packages/core/src/costs/anthropic-import.ts` | The CSV reader |
| `apps/web/src/app/(admin)/profit/page.tsx` | Money → Profit |
| `apps/web/src/app/(admin)/settings/costs/register-*.tsx` | The register UI |
