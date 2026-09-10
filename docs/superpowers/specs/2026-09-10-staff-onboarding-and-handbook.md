# Staff handbook, onboarding and the walkthrough

**Written 10 September 2026. Not built — this is the plan to execute.**

Shoji's brief, verbatim in intent: *send someone a login; they enter their
details; they get a walkthrough matched to their role; they learn how to clock
in and out; and when that flow ends and they reach the dashboard they know
exactly what they are working on.*

Plus one question he asked alongside it, answered in §1: does every module that
needs help have help next to it.

---

## 1. What already exists — do not rebuild any of this

Checked against the live database and the repository on 10 September 2026.

| Thing | State | Where |
|---|---|---|
| Roles | `owner`, `staff` (`member_role` enum). Clients are a separate portal, not members. | `packages/db/src/schema/system.ts` |
| Creating a member | Works, with a one-time password and an invitation email | `packages/core/src/team/create-member.ts` |
| Permissions | `requirePermission(...)` gate returning `{ ok, session } \| { ok, message }` | `apps/web/src/lib/permissions.ts` |
| Clock in / out | Built 10 Sep. `time_entries`, plus a shift that starts itself on sign-in | `packages/db/src/schema/team.ts` |
| Staff activity | `staff_activity` records what hours went into | same |
| Help, per screen | `HelpButton` in the admin header, route-aware, opens the guides pinned to the current path | `apps/web/src/components/help-button.tsx` |
| Guides | **39 articles, all published, covering 39 routes** | `knowledge_articles` |
| Gap list | `/knowledge/gaps` shows screens with nothing written | `apps/web/src/app/(admin)/knowledge/gaps` |

### The answer to "is help linked next to every module?"

**Yes, and by a better mechanism than a link per module.** Help is not a link
beside each heading — it is one button in the header that knows what screen you
are on and opens the guides pinned to that route. The reasoning already written
into `help-for-route.ts` is the right one and should not be undone:

> Nobody can predict where an individual gets stuck; what can be arranged is
> that wherever they are, the help for that place is one click away.

**The real gap is coverage, not wiring.** 39 routes have a published guide.
There are ~78 `page.tsx` files under `(admin)`. Most of the difference is detail
screens (`/clients/[id]`, `/leads/[id]`, `/invoices/[id]`) which currently
inherit nothing. A person on a client detail screen gets "nothing written yet".

**Task H (§6)** closes that. It is a prerequisite for the walkthrough, because a
tour that points at empty help pages teaches somebody that help is empty.

---

## 2. What is actually missing

1. **No handbook.** Nothing states how the business works, what is expected, or
   what the rules are. New staff learn by asking Shoji, which does not scale and
   is not consistent between people.
2. **No first-login flow.** A new member signs in and lands on the full
   dashboard, cold. Every screen, no context, no idea what is theirs.
3. **No role-based walkthrough.** Owner and staff see different things and are
   responsible for different things; nothing explains which.
4. **Clock-in is not taught.** It works, but nobody is told it exists, so hours
   go unrecorded and the activity data is wrong from day one.

---

## 3. Design decisions, made now so they are not re-litigated

**The handbook lives in `knowledge_articles`, not a new table.** It already has
audiences (`staff` / `admin`), publishing, route pinning and a search index. A
second content store would mean two editors, two search boxes and two things to
keep current. Handbook articles are marked with a `handbook` flag so they can be
listed as a book as well as surfaced per screen.

**Onboarding is a state machine on a row, not a wizard in React state.**
Somebody will close the laptop halfway through their first day. The same
reasoning as the brief funnel applies: progress that lives only in a component
is progress that is lost. One row per member, advanced a step at a time.

**Onboarding is not skippable, but it is interruptible.** They can leave and
come back; they cannot dismiss it and never see it. An owner can mark a member
as already inducted (for Shoji himself, and for anyone trained in person) — that
is an explicit act by an owner, recorded, not a "skip" button on the flow.

**Acknowledgement is per section, not one tick at the end.** "I have read the
handbook" against 4,000 words is a tick nobody means. Per-section
acknowledgement, timestamped, is worth something if it is ever needed — and
tells you which sections people skim.

**The walkthrough points at the real screens.** No screenshots and no simulated
UI: a tour built from pictures is wrong the first time a screen changes. It
navigates to the actual route and highlights the actual thing.

**Clock-in comes last, immediately before the dashboard.** It is the one thing
they must do daily, so it should be the last thing they were shown, and the flow
should end by clocking them in — not by explaining that they should.

---

## 4. Data model

Additive only. Three new tables, one new column.

### `staff_onboarding`

One row per member. Created when the member is created, not on first sign-in —
so an owner can see who has been invited and never turned up.

```
...tenantColumns()
userId            text     not null        -- Better Auth user id
step              enum     not null        -- see below, default 'details'
completedSteps    jsonb    not null []     -- steps the server has accepted
startedAt         timestamptz
completedAt       timestamptz
inductedByUserId  text                     -- set only when an owner marks it done in person
unique (organisationId, userId)
```

`staff_onboarding_step` enum, in order:

| Step | What happens |
|---|---|
| `details` | They give their own details (§5.1) |
| `handbook` | Read and acknowledge the sections for their role |
| `walkthrough` | Guided tour of the screens they will use |
| `clock` | How clocking in and out works, then their first clock-in |
| `done` | Dashboard, with a short "here is what is yours today" |

### `staff_profiles`

Deliberately separate from Better Auth's `user`. That table is authentication;
this is employment, and the two have different lifetimes and different people
allowed to edit them.

```
...tenantColumns()
userId              text  not null unique
displayName         text  not null
phone               text
emergencyName       text
emergencyPhone      text
startedOn           date
jobTitle            text
notes               text                   -- owner-only
```

**Emergency contact is optional and marked as such.** It is sensitive, it is not
needed to do the job, and a required field here means somebody types nonsense
into it on day one.

### `handbook_acknowledgements`

```
...tenantColumns()
userId       text not null
articleId    uuid not null -> knowledge_articles
version      integer not null   -- the article's version when acknowledged
acknowledgedAt timestamptz not null default now()
unique (organisationId, userId, articleId, version)
```

Versioned on purpose: when a policy changes, the old acknowledgement is still
true about the old text, and the person is asked again about the new one.

### `knowledge_articles` — one new column

```
handbookSection  text   -- null for ordinary guides; a section name for handbook pages
```

Null means "a guide for a screen". Non-null means "also a chapter of the
handbook", which is what lets one store serve both without a second table.

---

## 5. The flow, screen by screen

Route: `/welcome` under `(admin)`, outside the dashboard shell (no sidebar — it
is not a place to wander off from). Middleware sends any member whose
`staff_onboarding.step != 'done'` to `/welcome` from any `(admin)` route.

### 5.1 `details`

Heading: **"First, let's get you set up."**

Fields: display name (prefilled from the invitation), job title, phone, start
date, emergency contact name and number (both marked *optional*).

- Saved on Continue, validated server-side.
- Nothing here blocks progress except display name.

### 5.2 `handbook`

Shows the sections for their role, one per card, each expanding to the full text
with an **"I've read this"** button. Continue is disabled until every required
section for that role is acknowledged.

Sections (all of these need writing — see §6, Task A):

| Section | Audience | Why it exists |
|---|---|---|
| Who we are and what we do | both | The businesses, in plain terms |
| Your first week | both | What to expect, who to ask |
| Hours, clocking in, and time off | both | The rules, stated once |
| How we talk to clients | both | Tone, response times, what not to promise |
| What you can decide alone | staff | The single most useful page in the book |
| Approvals: what needs Shoji | staff | What stops and waits, and why |
| Handling client data | both | The rules that are not negotiable |
| When something breaks | both | Who to tell, in what order, how fast |
| Money: invoices, quotes, refunds | staff | What staff may and may not say about price |
| Passwords and access | both | Practical security, not a lecture |
| Owner's section | admin | Deploys, credentials, what only an owner touches |

### 5.3 `walkthrough`

Ordered stops. Each: navigate to the real route, highlight a real element,
one sentence, Next.

**Staff route** (7 stops): Dashboard → Tasks (yours) → Clients → Support inbox →
Leads → Time (your hours) → the Help button.

**Owner route** (11 stops): the staff seven, plus Approvals → Billing →
Team → Settings.

Last stop on both is **the Help button**, with the line: *"Every screen has
this. It knows where you are."* That is the stop that makes the other 39 guides
worth having.

### 5.4 `clock`

Explains: a shift starts itself when you sign in; it does not end itself; here
is where you end it; here is where your hours show up; here is what happens if
you forget.

Ends with a real **Clock in** button. Pressing it completes onboarding.

### 5.5 `done`

Dashboard, with a dismissible panel: *"You're clocked in. Here's what's yours
today"* — their open tasks, tickets assigned to them, and anything overdue.
Dismissible, and gone for good once dismissed.

---

## 6. Order of work

Sized in half-days. **A and H can be done by anybody; B–G are sequential.**

| | Task | Size |
|---|---|---|
| **A** | Write the eleven handbook sections. Content work, not code. Do this first — everything else is scaffolding around it. | 2 days |
| **B** | Schema: three tables, one column, migration. Additive, reversible. | 0.5 |
| **C** | Services in `packages/core/src/onboarding/`: create row, advance step, record acknowledgement, mark inducted. Tests first. | 1 |
| **D** | `/welcome` shell + middleware redirect + the `details` step. | 1 |
| **E** | `handbook` step, reading from `knowledge_articles` where `handbookSection is not null`. | 1 |
| **F** | `walkthrough` — the tour engine and both route definitions. | 1.5 |
| **G** | `clock` step and the `done` panel. | 0.5 |
| **H** | Help coverage: write guides for the ~39 uncovered routes, mostly detail screens. Independent of everything above. | 2 days |

**Total: roughly 10–11 days of focused work**, of which 4 are writing English
rather than code.

---

## 7. The parts that will bite

Listed because each one is cheap to handle now and expensive to discover later.

1. **Shoji himself.** He is an owner with no onboarding row and must not be
   forced through a walkthrough of his own product. Backfill: existing members
   get a row already at `done`, `inductedByUserId` set to themselves. Do this in
   the migration, not by hand.

2. **The middleware redirect is a trap.** It must exempt `/welcome` itself, the
   API routes, sign-out, and static assets — or it redirects to itself forever.
   Write that test before the middleware.

3. **A member deactivated mid-onboarding.** Deactivation must not leave a
   half-finished row that blocks a later re-invite. Reactivating resumes where
   they were.

4. **The walkthrough highlights elements that may not exist.** A staff member
   without billing permission has no billing nav item. Every stop needs a
   permission condition, and a missing target must skip the stop silently
   rather than pointing at nothing.

5. **Handbook text will change.** Acknowledgements are versioned for this; the
   UI needs a way to say "this changed, please read it again" without making it
   feel like a punishment.

6. **Two tabs.** Same as the brief funnel: advancing a step must be idempotent
   and server-validated, or two tabs produce two steps forward.

7. **Do not let the tour block the product.** If the tour engine throws, the
   person must land on the dashboard, not a white screen. Wrap it and record the
   failure.

---

## 8. What must be proven before this is called done

- A brand-new member, from invitation email to clocked-in dashboard, without
  anybody explaining anything to them.
- Closing the laptop at every one of the five steps and coming back to the same
  place.
- An owner and a staff member get demonstrably different walkthroughs.
- Every handbook section a role must acknowledge is acknowledged, timestamped,
  and versioned.
- The help button, on ten screens picked at random, opens something written
  rather than "nothing written yet".
- Existing members — Shoji included — are unaffected and never see `/welcome`.

---

## 9. Where to start on Saturday

Task **A**. The eleven sections are the actual product here; the flow around
them is a week of ordinary engineering. Written badly they will be skimmed and
ignored, and the walkthrough will be decoration.

The one section worth most care is **"What you can decide alone"** — every new
person's real question, on every job, is *am I allowed to do this without
asking?* Get that page right and the rest of the handbook is reference material.
