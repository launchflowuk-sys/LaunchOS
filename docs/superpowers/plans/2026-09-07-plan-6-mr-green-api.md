# Plan 6 — Mr. Green, the LaunchOS API

**Living document. Updated as work lands.** The decisions behind it are in
`docs/superpowers/specs/2026-09-07-mr-green-api-and-portal.md` (14 numbered
points, all settled). This file is the build order and the state of it, so
neither Shoji nor a future session has to reconstruct where things got to.

---

## What Shoji actually asked for, in his words

Kept verbatim because paraphrase drifts:

- *"I asked Jarvis when I wake up"* — a spoken answer to "what is happening",
  every morning. **This is the core workflow. Everything else is follow-up.**
- *"Live Data so he is completely aware of what is happening at all times."*
- *"if I want him to ever just take everything in Control I should have that
  option"* — later corrected: not holiday mode, **supervised autonomy with a
  dial**. Being away is one setting of it, not the point of it.
- *"A list of available things that are related to launch flow for the entirety
  of its being exists and then I can choose from it"* — the capability
  catalogue, generated not hardcoded.
- *"the ability to lay down that information to my employees when I have some
  running it"* — the brief has an audience beyond him. Not a private pipe.
- *"the staff member sees anything I allow them to see"* — scoped by the
  existing `PERMISSION_KEYS`, not a parallel system.
- *"We can sell it as saas"* — the **API** is the product. Mr. Green is his
  private front end and never ships.
- *"I am all about options."*
- On the portal: *"cant see me retaining clients without providing contineous
  value at 45 pound"* — the panels are a retention argument, not a nicety.

**His name is Mr. Green.** Not Jarvis (that was the old project name), though
he still says Jarvis in conversation.

---

## Build order and state

| # | Phase | State |
|---|---|---|
| 1 | **The key and the door** — `api_tokens`, auth, rate limit, `GET /api/v1/brief` | **done, 7 Sep** |
| 2 | The rest of the reads — clients, leads, approvals, incidents, invoices | **done, 7 Sep** |
| 3 | Capability catalogue — `GET /api/v1/capabilities`, generated from the registry | **done, 7 Sep** |
| 4 | Acting through the OS — `POST /api/v1/actions/{key}`, policy gate, hard floor server-side | **done, 7 Sep** |
| 5 | Awareness by push — durable outbox, ack cursor, notify-by-exception | **held — see below** |
| 6 | The autonomy dial — time-boxed, catalogue-selected, auto-expiry | **held — see below** |

**Separate track, stronger money argument:** the client portal panels (spec
points 6, 7, 8, 11). Decide between continuing 2–4 and pivoting to the panels
*after* Phase 1 has been used for a while, not now.

**Deliberately sequenced late:** Phase 5. Spec point 13 says design against
alert fatigue, and what deserves to interrupt him cannot be calibrated before
he has lived with the brief. Building the rules early means building the wrong
ones and then muting the channel.

---

## Stopped here deliberately, 8 Sep 2026

**Shoji's call, and it is the right one.** In his words: *"right now I'm
building building building and I haven't even tested one workflow — once I add
my own businesses that's when we will finally know, that's where I will find
the gaps, that's how I will fix it."*

Phases 1-4 are built and pushed. Phases 5 and 6 wait for **real data**: his own
businesses running through LaunchOS for a week or so, and then supervised
autonomy switched on and tested against work that actually happened.

Why this is not merely reasonable but necessary for these two phases
specifically:

- **Phase 5 is notify-by-exception (point 13).** Its entire design is deciding
  what deserves to interrupt him. That cannot be calibrated against seed data —
  it can only be learned from noticing what he actually checks for, and what he
  wished he had been told. Build the rules now and they get built wrong, and a
  channel that cries wolf is muted before the day it matters.
- **Phase 6 is the autonomy dial.** Handing over categories of work is only
  safe once there is evidence of what those categories look like in practice.
  Phase 3 already found that the hard floor lives in message *content* rather
  than in tool identity — that finding came from looking at real tools, and the
  rest of the design needs the same treatment against real messages.

**When it resumes:** a week or so of live use, then switch on supervised
autonomy in a time-boxed window and test it against real work. The gaps found
there are the specification for phases 5 and 6.

---

## Phase 1 — what it contains

1. `api_tokens` table. Org-scoped, SHA-256 of the token only, a stored prefix
   so a row is identifiable on screen, `last_used_at`, optional expiry,
   revocable without a deploy.
2. `packages/core/src/api-tokens/` — issue, verify, list, revoke. Issue and
   revoke are audited.
3. `apps/web/src/lib/api/` — the bearer check, per-token rate limit, the JSON
   error shape every `/api/v1` route shares.
4. `GET /api/v1/brief` over the existing `opsMetricsSnapshot`.
5. Settings screen to issue and revoke.

**Verified end to end** against the local dev server, not just unit-tested:
no token -> 401 with `WWW-Authenticate`; a made-up token -> the same 401;
`hours=0`, `500` and `abc` -> 400; a token scoped `support`+`billing` -> the
seven sections those cover, with `omitted: ["content","approvals","agents","team"]`.

### Decisions made while building

- **SHA-256, not bcrypt/argon.** Those exist to slow brute force against
  low-entropy human-chosen passwords. This token is 32 random bytes; there is
  nothing to brute force, and a slow hash on every API call would only buy
  latency. GitHub's own PATs work this way.
- **`verifyApiToken` does not take an `organisationId`.** It is the one place
  in `core` that cannot: the token is *how* the organisation is discovered.
  Every function it hands off to still takes one. Commented at the callsite so
  it does not read like a tenancy bug.
- **A revoked or expired token answers 401, never 403.** 403 would confirm the
  token was once real.
- **The brief returns numbers, not prose.** The spec said "prose + numbers",
  and this is a deliberate departure worth Shoji's eye. Generating prose here
  would mean an LLM call on every request — seconds of latency and a cost — to
  produce sentences Mr. Green is about to rewrite in its own voice anyway. Mr.
  Green *is* a language model. The API's job is to be the thing that cannot be
  wrong; the talking is his. The in-app Ops Brief agent is unaffected.
- **A brief names the sections it withheld.** Without `omitted`, a token scoped
  to billing alone gets a reply with no `cases` key and no way to tell "nothing
  happened in support" from "you were not allowed to look" — and an assistant
  reads that as a quiet morning during an outage. Absence must never be
  reportable as zero.
- **The `access` permission grants nothing in the brief.** There is no summary
  of a password vault that belongs in a morning briefing; a count of
  credentials is still a fact about credentials.
- **Two rate limiters, not one.** Per-address on failures (20/min) is what
  makes guessing pointless; per-token (120/min) only stops a wedged client
  hammering the database. In-process, like the lead form's — when tokens are
  sold, this moves to Postgres.

### Two bugs this work turned up, both fixed

- **`listApiTokens` reshuffled.** `created_at` defaults to `now()`, which in
  Postgres is the *transaction's* start time — so two tokens issued together
  carry an identical timestamp and the order fell to the planner. Fixed with an
  id tiebreak, matching what `listAgentRuns` already does.
- **A client component importing `@launchos/core` broke the page.** The barrel
  reaches `channels` -> `web-push` -> node's `net`, which cannot exist in a
  browser bundle. Typecheck cannot see this; only a bundler or a browser can.
  The server component now passes the permission labels down as props. **Worth
  remembering: any new client component that imports from core will do this
  again.**

---

## Phase 2 — what it contains

`GET /api/v1/clients`, `/leads`, `/approvals`, `/incidents`, `/invoices`, each
scoped, paged and filterable.

Three read models had to be written first — `listApprovals`, `listIncidents`
and `listInvoices` did not exist; the admin screens queried Drizzle directly.
They now live in `core` where CLAUDE.md says they belong, with tests.

**Verified live**, wide token vs billing-only token: all five return data for a
token holding their scope, and 403 naming the missing scope otherwise. Bad
input is 400 in every case — `limit=999`, `status=pendign`, a malformed
`clientId`, a negative offset.

### Decisions

- **Scopes are stricter than the admin.** The sidebar shows Clients and Leads
  to any signed-in member with no permission at all; the API puts both behind
  `support`. An admin session is a person who authenticated as themselves; a
  token is a key that might be on a lost laptop, so it starts able to read
  nothing.
- **`listApprovals` never returns `payload`.** That field holds the actual
  outward action — the message body about to reach a client, the DNS record. A
  reader needs to know a decision is waiting, of what kind, and for how long.
  Deciding it stays a human act in the admin, where the payload is shown to the
  person taking responsibility.
- **There is no decide endpoint, and there should not be one in this phase.**
  Rule 2 exists to keep that in a person's hands.
- **`listInvoices` totals every matching row, not the page.** "How much am I
  owed" is the real question; an assistant adding up one page answers it
  confidently and wrongly. Postgres `sum()` returns a numeric *string* (and
  null over no rows), so it is cast — otherwise addition becomes concatenation.
- **An unknown filter value is refused, not ignored.** `?status=pendign`
  quietly returning everything is how a caller comes to believe a filter is
  applied when it is not.
- **`listIncidents` joins the client and site names in.** An incident read
  aloud as "site 4f2a…" is useless, and a lookup per row is what makes an
  assistant slow and chatty.

### A bug this turned up

`InvoiceListRow` typed `number`, `issuedAt` and `dueAt` as nullable. All three
are NOT NULL in the schema — the types were lying, and the `dueAt !== null`
guard in the overdue calculation was dead code. Found because a test fixture
would not insert without them.

---

## Phase 3 — what it contains

`GET /api/v1/capabilities`, gated on `settings`. Most of the enumeration
already existed: `apps/web/src/lib/agent-catalog.ts` builds itself from the same
`agentRegistry` the worker runs, so nothing here is a maintained list.

Live against the real registry: **9 agents, 43 tools, 38 automatic, 5 always
asks** — and the five are exactly the five `requires_approval` tools.

### Decisions

- **Approval-gated means never delegated, by default.** Supervised autonomy
  will loosen categories *explicitly*, one at a time. A default of "delegable
  unless someone remembered to mark it" is how a tool added in six months
  quietly gains the right to message a client.
- **Three enablement states, not two.** `true` on, `false` switched off, `null`
  never configured. Reporting a never-configured agent as "off" is a small lie
  Shoji might act on. Three of his nine are currently `null`.
- **A stale enablement row cannot invent a capability.** The registry is the
  source; enablement only annotates it.

### What Phase 3 found that Phase 6 has to solve

**The hard floor cannot be classified from the tool.** Spec point 4 says price,
discounts, dates, money and legal always wait — but none of the five
approval-gated tools is inherently any of those. `messages_reply_to_client`
might say "your site is back up" or "that will be £2,000". The floor is a
property of the **content**, not of the tool, so the catalogue cannot mark it,
and a catalogue that pretended to would look authoritative and be wrong.

So when autonomy is built, the floor is enforced by screening the *content* at
send time, and `delegabilityOf` moves into `packages/agents` so the worker
enforces the same rule the catalogue advertises. Written down because it is the
one place this design could quietly go wrong.

---

## Phase 4 — what it contains

`POST /api/v1/actions/{key}`, gated on `settings`. It puts a job on the same
`agent.run` queue the cron dispatchers use, and stops. The worker re-checks
enablement, `resolvePolicy` takes the stricter of environment and organisation,
and `runAgent` parks every approval-gated tool — none of which this route can
influence, because it is not on that path. That is spec point 5 made real:
nothing new had to be trusted.

Answers **202**, not 200. The run is accepted, not performed.

### Only two agents, and why

An agent's payload is not free-form: Support Triage wants a ticket, Content
Writer a client and a period. Accepting those ids from outside means proving
each belongs to the caller's organisation, and the functions that prove it
(`ticketPayload`, `incidentPayload`) live in `apps/worker`, which `apps/web`
must not import from. Guessing a payload shape would be a tenancy hole dressed
as a convenience.

So the API starts the two agents whose subject is the whole organisation —
**Ops Brief** and **Ad Performance Sentinel** — which are also the two Shoji
would ask for out loud. The rest stay event-driven and say so when asked, in
words that distinguish "no such agent" from "that one runs on its own".

### The bug live testing found

`hasAgentRunInFlight` reads `agent_runs`, so it only sees a run the worker has
already **started**. Between queueing and pick-up there is a window — a second
normally, longer if the worker is busy or down — where a retry passed every
check and queued a **second billed Claude call**. Unit tests could not see it;
two POSTs a second apart did.

Closed by bucketing the pg-boss singleton key to 60 seconds, which is the one
place that can refuse a duplicate without racing. When pg-boss does refuse one,
the caller is told **409**, not "accepted" — being told a second run is coming
when it never will is exactly the failure this route is shaped to avoid.

`conflict` (409) was added to the error codes at the same time: "already
running" is a state conflict, not a malformed request.

---

## Also changed

`pnpm test` now runs one package at a time (`--workspace-concurrency=1`). Four
suites in parallel against a 100-connection Postgres was already at the ceiling
and failed intermittently in a different file each run; the extra test file
here tipped it over. Slower, and trustworthy — which is the right trade for a
suite whose whole job is to be believed before a deploy.

## Open questions for Shoji

One, non-blocking: **is numbers-without-prose the right call for the brief?**
Reasoning above. Easy to add stored prose later if he disagrees.

Next: phase 3 (capability catalogue) or pivot to the client portal panels.
Recommendation stands — use the API for a few days first.

Standing, non-blocking:
- Setup fee, minimum term, and whether new pages count as "changes" or
  "builds" — pricing decisions from 7 Sep, still unanswered.
- Whether `launchflow.co.uk` becomes a client in its own portal (he raised it;
  it is how the panels get dogfooded).

## Outstanding on his side, unrelated to this plan

- GitHub source reconnect on `launchos-web` and `launchos-worker`
  (`source_id = 0` — no push has ever triggered a deploy).
- Optional: raise Coolify's `server_disk_usage_check_frequency` from daily
  (`0 23 * * *`) to hourly and drop the threshold to 75, so a filling disk is
  warned about early. See the outage note below.
- Rotate the Coolify API token: it was pasted into a chat and travels over
  plain HTTP to `:8000`.
- ~~`GSC_SERVICE_ACCOUNT_JSON`~~ **done, 8 Sep 2026.** Service account
  `launch-os-search-console@cabio-master`, key in `.env`, raw file kept outside
  the repo at `C:\Users\shoji\.gcloud-keys\`. Two gotchas cost an hour and are
  worth remembering: enabling the Search Console API in *one* Google Cloud
  project does not enable it in another, and Search Console permissions
  (search.google.com) are a different thing entirely from enabling the API
  (console.cloud.google.com).

  **The property is a domain property: `sc-domain:launchflow.co.uk`.** The
  URL-prefix form `https://launchflow.co.uk/` 403s because it does not exist.
  Whatever column eventually holds a client's property must store the full
  identifier including the `sc-domain:` prefix, not a bare hostname.

  Outstanding: the permission was granted as **Full**. The adapter only ever
  requests `webmasters.readonly`, so nothing can be written either way, but it
  should be downgraded to Restricted on principle.


---

## The 7 Sep outage, and what was done about it

The host filled to 100% (0 bytes free) after a night of repeated deploys, and
every site on it returned 503 — `launchflow.co.uk`, `os.launchflow.co.uk` and
Coolify's own API. 61.7GB was reclaimed: 54.9GB of stale images, 6.9GB of build
cache. No volume was touched; all 8 total 384MB and every database was intact.

**Coolify's own cleanup could not save it, structurally.** The cleanup lives
inside Coolify, so when the disk fills Coolify is the first thing to stop
working and the cleanup dies with it. Its settings were already sensible —
daily at midnight, 80% threshold, force on — and none of it ran, because by
midnight there was nothing left running to run it. Its disk-usage *check* is
also only daily (`0 23 * * *`), so the 80%-to-100% climb happened entirely
inside one check window.

`/etc/cron.d/docker-prune` now runs on the host every 6 hours, outside Coolify,
pruning images and build cache older than a week. Proved with a one-minute
sentinel cron rather than assumed. It can touch no volume.

The box is shared — hostname `Nexusedu`, 14 containers — so LaunchOS builds
filling the disk take every other site down with them. Worth separating.

---

## Outlook — ideas from a dashboard mockup, 8 Sep 2026

**Not decisions. Not a specification. Nothing here is agreed**, and Shoji said
so explicitly when he shared it: *"yes but for outlook not what i want"*. Kept
only so two good ideas are not lost.

Source: a dark-themed LaunchFlow OS dashboard mockup
(`C:\Users\shoji\Downloads\lf dash.png`). Its numbers are decoration — 28
clients, £24,800/month, and a date in 2025 — so nothing about the data shapes
should be taken from it.

**1. A "Needs attention" panel.** Five rows: an approval overdue two days, a
domain expiring in five, an open ticket, content waiting three days, an invoice
seven days overdue. That is notify-by-exception (spec point 13) drawn as a
screen — the brief endpoint rendered rather than read aloud. Worth remembering
when phase 5 resumes, because it is a better starting point than a blank page.

**2. A "Mr Green AI activity" feed inside LaunchOS.** The mockup shows recent
agent actions — leads analysed, a brief generated, content suggested, websites
checked — in the admin itself. That differs from the spec, which has Mr. Green
as a private front end that never ships. Surfacing his activity *inside*
LaunchOS may be better: `agent_runs` and `agent_steps` already hold exactly this
and it would appear where Shoji is already looking. An addition to consider, not
a replacement for the API.

**One open question the mockup raises.** It is dark. `CLAUDE.md` and Shoji's own
standing preference both say white/light and professional, no dark decorative
themes. That rule was written with client-facing work in mind, and the admin is
neither client-facing nor decorative — but the client portal shares this
codebase, and the two must not end up fighting. Worth settling deliberately
before any of it is built.
