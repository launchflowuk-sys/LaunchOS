# Shoji's backlog — 9 Sep 2026

Fourteen items given in one go, with screenshots. Recorded verbatim in intent
so none of it is lost between sessions. Nothing here is started unless the
status says so.

---

## The theme running through most of it

**Tables are boxed into a narrow centre column and look like developer output.**
He said it about Clients, Leads, Agent Runs, Costs and Email — but the
instruction is *software-wide*: "do the same for All Tables". Treat the
centred `max-w-6xl` workspace as the thing to change for table-heavy screens,
not each page in turn.

The second theme is **KPIs**. Several screens have no summary at all, so there
is no way to glance at them. Where a screen lists things, it should first say
what the list amounts to.

The third is **"AI slop"** — his words for amber-everywhere warning blocks and
1980s log tables. Colour must mean something, and grouping beats repetition.

---

## 1. Activity page — **DONE** (`03cb43e`)

Select instead of 28 pills, three summary figures, and grouping by part of the
business instead of by day, each group a card headed by its category colour.

### Original ask

Needs a **client selector**, then that client's notifications shown as a
**summary plus grouped cards** — modern, clean, categorised by colour. Not the
current flat list.

## 2. Full-width tables, software-wide — **DONE** (`ef7ba9f`)

A screen whose subject is a table sets `wide` on its `PageHeader`, which paints
`data-workspace="wide"`; the admin layout drops its `max-w-6xl` with `:has()`.
Applied to 28 list screens. Prose, forms and single-record screens keep the
reading column deliberately — unclamping everything makes a description two
thousand pixels wide.

### Original ask

Clients table carries the least information of any screen and is boxed into
the middle. It needs a **full-bleed view**, and so does **every other table**
in the product — Leads and the rest included. More columns are coming.

## 3. Funnels page — **DONE** (`60ff42e`)

`items-end` on a row where one field carries help text made that sentence the
row's bottom edge. Aligned from the top instead.

### Original ask

Alignment is broken: helper text sits under a field and pushes the row out of
line. Fix the layout.

## 4. Costs — **DONE** (`08841a6`)

Names resolve now. Hostinger's API carries no domain on a subscription — checked
against the live account — but it carries when the subscription started, and a
domain and its subscription are created in the same checkout seconds apart. That
resolves **27 of 27** domain subscriptions with nothing ambiguous, where the TLD
alone resolved almost none. `matchCostToDomain` is pure and separate from the
sync, and returns nothing whenever two candidates are equally close.

Mailboxes and hosting, which the bill ties to no domain at all, are offered to a
domain bought the same day and marked as a guess.

The screen is rebuilt: full width, five figures, four grouped sections — trials
with a deadline, lines with no client, what each client costs, then everything.

**Still open:** 24 "Starter Business Email" lines cannot be resolved from the
supplier's data at all, only guessed at by date. They need assigning by hand
once, and then they stay assigned.

### Original ask

- Table is far too long and uncategorised.
- Should **resolve real names** — the domain, the website, the email
  subscription each line pays for — so assignment is possible. 53 rows of
  "Starter Business Email" cannot be assigned by hand.
- Needs **grouping** and better arrangement.
- Needs **more KPI detail** on the things that matter.

## 5. The yellow warnings — **DONE** for Costs (`08841a6`)

The amber slab on Costs is gone. Trials are a normal table that names every
subscription; the colour moved to the two KPI tiles that actually need a
decision, using `StatCard`'s existing `attention` mechanism. Other screens still
to sweep.

### Original ask

They look amateur. Group them, drop the slop colouring, and **say which
subscription** each one is about — a warning that names nothing is not usable.

## 6. Billing that is not Stripe — **BUILT, NOT APPLIED**

`subscription_lines` and `subscriptions.collection_method` exist, and the method
enum already covers `bank_transfer`, `standing_order`, `direct_debit`, `cash` and
`other`. The form is on **Clients → [client] → Payments**. Nobody has used it:
AMO Rendering still reads £99 and wants two lines (2 × £45, plus £110 ad
management) collected by bank transfer. That is production data entry.

### Original ask

**AMO Rendering shows £99.00 active. It is wrong.** He invoices £200 a month:
£45 × 2 websites (£90) plus £110 ad management, paid as **one lump sum by bank
transfer**, not Stripe.

Needed: a way to **set up and manage complex billing** — several lines making
one charge — and payment methods beyond Stripe: **bank transfer, cash,
standing order, and direct debit later**. Give him options.

## 7. Deleting approvals, and deletion guards generally — **DONE**

Rejected approvals delete one at a time or all at once. Pending and approved
are refused in core, not in the caller: a pending card is still a decision
somebody owes, and an approved one is the record of what an agent was allowed
to do.

On deletion generally: the surface is smaller than it looked. Only four things
in the product delete rows at all. `clients` already refuses when money is
attached and lists what will be destroyed otherwise, which is the policy Shoji
chose. Lead suppressions, task templates and push subscriptions have no
dependents — task templates are `on delete set null`, so tasks already created
survive. Nothing else needed a guard.

### Original ask

Rejected approvals sit there with no way to remove them. Needs **delete one**
and **delete all**. More importantly: think about **every deletion in the
product** — what it is connected to, and what KPI it feeds — and put guards in
so nobody removes something that breaks the business.

## 8. Agent Runs — **DONE** (`d205e84`)

Opens with the agent's real name from the registry and what started it in
words, then what happened, then when. Counts kept but demoted.

### Original ask

Full-width like the rest, and stop looking like a 1980s registrar entry. The
view holds a lot of information and the presentation does not do it justice.

## 9. Email tab — **DONE** (`d205e84`)

Five figures where there were none. Three can demand something: failures all
time, messages queued over fifteen minutes, and active clients with no support
address.

### Original ask

The plainest, worst-looking table in the product. **No KPIs at all**, so no
overview is possible. Needs proper work.

## 10. Client archive and delete — **ALREADY BUILT**

Not missing. `archiveClient`, `deleteClient` with financial blockers and
work warnings, `/clients/archive`, and a delete section on the client page all
exist — they landed after this list was written.

### Original ask

**Missing entirely**: archive a client, and delete a client along with all
their data.

## 11. API token

A full-rights token for Claude is in the repo's `.env`. Read it from there,
never from chat.

## 12. API tokens page — **DONE** (`60ff42e`)

The endpoints are a table now: every route, what it answers, the permission it
needs. It also corrected the page, which claimed every endpoint is read-only
when `POST /api/v1/actions/{agent}` starts an agent.

### Original ask

Display the page and its information better — especially the bottom section
saying where a token is used. "Developer backyard" is the note.

## 13. Knowledge base

Build a knowledge base for the whole platform: **Admin, Staff and Client**.

## 14. Screenshots

All attached to the original message. The Clients, Funnels, Costs, Payments,
Approvals, Agent Runs and Email screens are the ones pictured.

---

## Also true, from the same screenshots — not asked for, worth knowing

- **Approvals**: four AMO Rendering posts were rejected for "Missing Image" on
  6 Sep. The content pipeline produced posts with no image and nobody has been
  back to them.
- **Agent runs**: 4 failed in 7 days, one with
  `tools.1.custom: For 'integer' type, properties maximum, minimum are not
  supported` — a tool schema Anthropic's API rejects. That is a real bug in a
  tool definition, not a transient failure.
- **Costs**: 53 subscriptions, **19 trials** that will start charging, $368.16
  of them. Assignment is unusable at that volume without item 4.
- **Clients**: "11 active, 9 still onboarding", **Collected to date £0.00** —
  worth checking whether that figure is right or whether payments are not
  being recorded.
