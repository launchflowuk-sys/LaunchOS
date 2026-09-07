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
| 3 | Capability catalogue — `GET /api/v1/capabilities`, generated from the registry | not started |
| 4 | Acting through the OS — `POST /api/v1/actions/{key}`, policy gate, hard floor server-side | not started |
| 5 | Awareness by push — durable outbox, ack cursor, notify-by-exception | not started |
| 6 | The autonomy dial — time-boxed, catalogue-selected, auto-expiry | not started |

**Separate track, stronger money argument:** the client portal panels (spec
points 6, 7, 8, 11). Decide between continuing 2–4 and pivoting to the panels
*after* Phase 1 has been used for a while, not now.

**Deliberately sequenced late:** Phase 5. Spec point 13 says design against
alert fatigue, and what deserves to interrupt him cannot be calibrated before
he has lived with the brief. Building the rules early means building the wrong
ones and then muting the channel.

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
- `GSC_SERVICE_ACCOUNT_JSON` — a **new** service account in `cabio-master`,
  no roles, added to Search Console as Restricted. Not the Play-publishing one.


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
