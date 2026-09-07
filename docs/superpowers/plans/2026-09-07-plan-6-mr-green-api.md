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
| 2 | The rest of the reads — clients, leads, approvals, incidents, invoices | not started |
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

## Also changed

`pnpm test` now runs one package at a time (`--workspace-concurrency=1`). Four
suites in parallel against a 100-connection Postgres was already at the ceiling
and failed intermittently in a different file each run; the extra test file
here tipped it over. Slower, and trustworthy — which is the right trade for a
suite whose whole job is to be believed before a deploy.

## Open questions for Shoji

One, non-blocking: **is numbers-without-prose the right call for the brief?**
Reasoning above. Easy to add stored prose later if he disagrees.

Standing, non-blocking:
- Setup fee, minimum term, and whether new pages count as "changes" or
  "builds" — pricing decisions from 7 Sep, still unanswered.
- Whether `launchflow.co.uk` becomes a client in its own portal (he raised it;
  it is how the panels get dogfooded).

## Outstanding on his side, unrelated to this plan

- GitHub source reconnect on `launchos-web` and `launchos-worker`
  (`source_id = 0` — no push has ever triggered a deploy).
- Rotate the Coolify API token: it was pasted into a chat and travels over
  plain HTTP to `:8000`.
- `GSC_SERVICE_ACCOUNT_JSON` — a **new** service account in `cabio-master`,
  no roles, added to Search Console as Restricted. Not the Play-publishing one.
