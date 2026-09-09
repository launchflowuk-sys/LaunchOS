# Shoji's second brief — 9 Sep 2026

Given in one message while the backlog was being worked. Recorded in intent so
none of it is lost. Nothing here is started unless the status says so.

The through-line, in his words: **make the platform "like a machine"** — capture
enough at the front that the back end can run itself, and make the value visible
enough that clients stay.

---

## 1. Invoices — the one he hit live

### 1a. Lines — **DONE** (`3969a2d`)
An invoice for £200 read "Monthly retainer — 2026-09". It was built from
`subscriptions.amount_pence`, a single number, so the multi-line billing reached
the Payments tab and stopped there. `subscription_lines` are now the invoice's
lines.

### 1b. Logo and layout — **OPEN**
The PDF has no logo and "still looks a normal invoice". Wants it corporate:
- Customer name and address block tightened up
- A **client reference number** on it
- The right-hand side filled — currently sparse
- Richer overall

`organisations` has `legalName`, address, `vatNumber`, `companyNumber`,
`invoiceFooter`. It has **no logo field at all**, so this needs a column and an
upload, not just CSS.

### 1c. Bank details — **OPEN**
Wants a setting to enter company bank account details, printed on the invoice.
Nothing in the schema holds them today. Belongs on `organisations` beside the
VAT number, and on the document beside the total. Needed because most clients
pay by transfer, which is what the collection-method work established.

### 1d. Date picker — **OPEN**
No date picker beside the package when adding a subscription manually for a
client. It reads a typed date correctly; there is just no picker.

### 1e. The due-date question — **ANSWERED, needs his decision**

What he saw: invoice issued 5 Sep, 30-day terms, due 5 Oct. Mark last paid
4 Aug, so on a monthly cycle payment was due around 5 Sep, not 5 Oct.

Nothing is broken. The system bills **in arrears**: `dueAt = issuedAt +
paymentTermsDays`, and `issuedAt` defaults to `subscription.currentPeriodStart`.
He is running the business **in advance**: the money is expected *on* the period
start, and the invoice is a notice sent before it.

Those are different models and the second is the one he wants. It needs the two
dates decoupled:

- **Due date** = the period start. The day the money is expected.
- **Issue date** = due date − notice days. When it is generated and sent.

So for a client on seven days' notice whose period starts on the 5th: generate
and send on the **29th of the previous month**, due the **5th**.

**He does not need to change the onboarding date.** The date that drives this is
`subscriptions.current_period_start`, and for Mark that is already right. What
is wrong is that `payment_terms_days` is being read as "days after we send"
when he means "days before it is due". Renaming that to notice days, and
scheduling generation at `period_start − notice`, fixes every client at once.

**Decision needed:** confirm in-advance is right for all clients, or whether
some are genuinely in arrears.

---

## 2. Clock-in on sign-in — **OPEN**

Everyone except him — staff and managers — should meet a dialog on sign-in:
their shift shown properly, and a clock-in code or a single **Clock in** button,
so a shift starts the moment they log in.

Then: **performance tracking**. What panels they opened, what they worked on.
Time tracking already exists (`/team/timesheets`, the clock widget); the panel
level of detail does not.

Worth saying plainly when this is built: this is monitoring of employees. It
should be visible to the people being measured, not silent.

---

## 3. Only post where there is somewhere to post — **OPEN**

One channel is connected across fourteen clients. Some clients have one, some
two, most none, and "most of them are not even bothered". Today the content
pipeline writes posts regardless, which burns model usage producing things that
have nowhere to go — and four AMO posts were already rejected for a missing
image.

Wanted: the planner and the poster both know which channels a client actually
has connected, and **only generate what can be published** — the right kind, for
the right platform, in the right quantity.

`plan-month` fires 06:00 on the 1st. This wants doing before then.

---

## 4. Client retention — the reports — **OPEN, needs his decision**

His worry, and he called it the biggest one. Clients must see what they are
getting, continuously, so that at the moment of paying they are not wondering
what they pay for.

He asked whether to do one monthly report or add a second mid-month one, and
asked for advice.

**Recommendation: one monthly report, and make it excellent.**

- Two reports halve the attention each gets, and the second one arrives with
  less to say — which teaches the client that these are noise.
- One report timed to land **five days before payment** does exactly the job he
  described: it is the thing they read immediately before deciding the money is
  worth it.
- Cadence should follow each client's own billing date, not the 1st of the
  month, so "five days before payment" is true for everyone.
- If mid-month contact matters, it should be an **event** — a site saved from
  going down, a post that did well — not a scheduled report with nothing in it.

He can produce mock-ups with Claude Design if given the content structure. That
structure should be written first, from what LaunchOS can actually evidence
(uptime, incidents resolved, content published, leads delivered, ads spend and
return, work done) — a mock-up of numbers we cannot produce is a promise that
breaks on first send.

---

## 5. The lead wizard — **OPEN, and he rates it highest**

The LaunchFlow front end has no detailed form. He wants the lead itself to
carry everything the back end needs, so the work can be automated from it.

Shape, in his words: click the contact / get-online button, page dims behind an
overlay, a **clean white Apple-style modal** with the LaunchFlow logo, stepping
next-next-next through questions, then a final **review screen** showing
everything captured in a structured, coloured, readable format before submitting
— then a clear "here is what happens next".

Questions he named: industry, business name, whether the company is registered
or a sole trader, their goals, whether they have a Google listing, whether they
have a Facebook page, what services they offer, what they are trying to achieve.

The point is not the form. It is that a rich lead lets the Brief Writer, the
Content Writer and the site build start with real material instead of a name and
an email.

---

## 6. Site generation from the brief — **OPEN**

He wants to use ChatGPT's latest model for site generation — he rates its design
and typography — and to reach a state where a lead arrives, the brief is
generated complete, and the site is built from it with a copy-paste, or
automatically.

The Brief Writer already produces good material (nine clients, zero failures,
and it correctly refuses claims a site does not support). The missing half is
everything in item 5: a brief is only as good as what came in.

Practical note for when this is built: an automated hand-off to another
provider's model means LaunchOS holds a second API key and a second bill, and
the output still needs a person to look at it before it reaches a client.
Copy-paste first, automate once the brief is reliably good enough.

---

## Suggested order

1. **Channels before the 1st** (item 3) — it is the only one with a deadline.
2. **Invoice logo, bank details, layout, date picker** (1b–1d) — he is sending
   these to clients now.
3. **Due-date model** (1e) — one decision, then it applies to every client.
4. **The lead wizard** (item 5) — the biggest multiplier, and everything in 6
   depends on it.
5. **Monthly report** (item 4) — content structure first, then the design.
6. **Clock-in and activity tracking** (item 2).
