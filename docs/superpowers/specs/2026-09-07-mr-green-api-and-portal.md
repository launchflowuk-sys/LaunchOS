# Mr. Green, the LaunchOS API, and what a client sees

**Status:** decided, not built.
**Asked for:** Shoji, 7 Sep 2026.

Mr. Green is Shoji's assistant — a separate project, running on Windows, nearly
finished. He wants to wake up, ask what is happening at LaunchFlow, and be told;
then tell it to deal with what needs dealing with; and, when he is away, hand it
the business.

## What already exists, which is most of it

`opsMetricsSnapshot` in `core/src/team/ops-metrics.ts` already answers "what is
going on" in one call: cases opened, resolved, awaiting first response, breaching
SLA; tasks open and overdue; incidents; approvals pending and how stale; invoices
overdue and outstanding in pence; content published and failed; agent runs and
failures; hours clocked and who is clocked in now; leads; projects; unanswered
client reviews; and which clients are over or near their package.

The Ops Brief agent already turns that into prose. So this is not a new
capability — it is an exposure job, and the sentence Mr. Green should say is
already being written.

## Decided

**1. The API is the product; Mr. Green stays Shoji's.** Every tenant gets the
API and plugs in what they like. Mr. Green is his private front end and never
ships. Nothing extra to support, and the assistant stays an edge a competitor
cannot buy.

**2. Live, by push, with a queue behind it.** Shoji wants Mr. Green aware at all
times, not polling on a timer. LaunchOS pushes an event the moment it happens.

Push alone loses whatever fires while the machine is asleep or the broadband is
down, so the push is backed by a durable queue Mr. Green drains and acknowledges
— instant when it is up, complete when it comes back. Push without replay is the
naive version of this and it fails silently, which is the worst way to fail.

**3. Holiday mode: time-boxed, switched on deliberately.** Normally everything
waits for Shoji's tick, exactly as rule 2 says. He hands over explicitly — "run
it for a week" — and inside that window Mr. Green auto-sends the agreed
categories, logs every action, and switches itself back off when the window ends.
One decision by a person, not a standing risk.

**4. The hard floor, which holds even in holiday mode.** These always wait:

- anything quoting a **price or discount** — a wrong number sent in his name is
  a commitment to honour or retract, and both cost
- anything promising a **date** — Mr. Green cannot know next week's capacity, and
  a missed date loses a client who was otherwise content
- anything touching **money** — refunds, cancellations, plan changes, credit
- anything **legal or contractual** — terms, complaints, liability, disputes

**5. Mr. Green acts through the OS, not around it.** It talks to the existing
agents, tools and approval machinery rather than getting its own write path.
Everything it does is already audited, already tenant-scoped, already reversible.

**6. The portal shows everything and asks for anything.** Clients see uptime,
what was done this month, posts published, invoices — and have a request box that
lands as a task. They stop wondering what they pay for and stop texting Shoji to
ask. What they cannot do is edit their own site: every self-serve action is a way
for a client to break something Shoji would have caught.

**7. Panels come from the package, with per-client overrides.** Ads panel if they
pay for ads, social panel if they get posts — then an individual panel can be
switched on or off for one client. That covers the custom arrangements without
inventing a package per client, and a new client is right automatically.

**8. Client numbers come from what LaunchOS already knows.** Uptime, posts,
blogs, GBP updates, leads captured, tasks done, invoices — all of it already in
the database. Analytics and Search Console are a later phase; the panels should
leave room for traffic to slot in beside them, but nothing waits on an OAuth
conversation with every client.

## Shape

```
GET /api/v1/brief        the whole picture, one call, prose + numbers
GET /api/v1/clients      GET /api/v1/leads
GET /api/v1/approvals    GET /api/v1/incidents
GET /api/v1/invoices
```

Small on purpose. Every endpoint is a thing to secure, version and keep honest.
Versioned `/v1/` from the first day, because there is now a consumer outside this
repository.

**Auth: a hashed `api_tokens` table, not an environment variable.** The existing
shared secrets (`PUBLIC_FORMS_TOKEN`, `INBOUND_EMAIL_SECRET`) are right for one
webhook and wrong for this. A table is revocable without a deploy — if the laptop
walks, the token dies from Settings — scoped read-only per token, scoped to one
organisation, and audited like every other write. It is an hour more work and it
is the difference between a secret in a file and something a business runs on.

## Open

1. What Mr. Green may do **inside** holiday mode, positively stated. The floor
   above says what it may never do; the list of what it may is not written yet.
2. Whether a holiday-mode action notifies Shoji as it happens or only in a
   summary at the end.
3. Whether the request box in the portal creates a task, a case, or both.
