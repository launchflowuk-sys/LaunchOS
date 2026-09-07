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

## Decided, 7 Sep 2026 (second pass)

**9. What Mr. Green may do is a catalogue, not a hardcoded list.** Shoji's idea
and a better one: LaunchOS enumerates everything it can do — every agent, every
tool, every panel action — and holiday mode is a selection from that list.

A hardcoded list goes stale the moment a capability is added, and goes stale
silently: the new thing simply never appears, and nobody notices until somebody
asks why Mr. Green cannot do the obvious. A catalogue means a tool registered
next year shows up in the picker the day it lands. It is also the only honest
way to answer "what can it actually do?" — the answer is generated rather than
remembered.

The tool definitions already carry `risk: "safe" | "requires_approval"`, so the
catalogue has somewhere to start and the picker has a sane default: safe things
offered, approval-gated things offered with a warning, and the hard floor
(price, dates, money, legal) not offered at all.

**10. Told as it happens, and able to be handed on.** Shoji wants to know at the
time, not in a digest — but he also said he needs to lay that information down
to employees when he has them running it.

That second half is a requirement, not a nicety, and it changes the shape: the
brief is not a private feed to one man's assistant, it is a view of the business
that can be handed to somebody else. So awareness is built as something with an
audience — assignable, shareable, and scoped by what a team member is allowed to
see — rather than as a pipe from LaunchOS to Mr. Green. Building it the narrow
way first and widening it later would mean rewriting it.

**11. A portal request makes a case, and the case raises a task.** Both, and in
that order. The case is the client's side: a thread, a promised response time,
replies they can see, so a request never disappears into a black box. The task
is the work: it lands on the board with everything else and is picked up the
same way. They are not two records of one thing — a case is a conversation and a
task is a job, and this is exactly the relationship they already have.

**12. It is not holiday mode. It is supervised autonomy, with a dial.** Shoji's
correction, and it matters enough to change the name before anything is built.
What he wants is to watch the business run itself while choosing what Mr. Green
may do and what reaches him, with the ability to turn it off. Being away is one
setting of that dial, not the purpose of it — he is still needed and still
involved.

A feature called "holiday mode" gets built as though it is only for holidays:
switched on rarely, tested rarely, and awkward for the everyday case that is
actually the common one. Everything decided above still holds — time-boxed,
deliberately switched on, hard floor intact — but it is a level of autonomy, not
an absence.

**13. Notify by exception, never by activity.** *(Shoji asked for a
recommendation; this is it.)*

A notification means **"you need to do something"**. If it means "something
happened", it is a feed item. That one rule decides every case:

- **Interrupts, immediately:** anything that hit the hard floor and is waiting on
  him; anything that failed; anything a client escalated or complained about.
  All rare, all genuinely his.
- **Accumulates silently:** every successful action, in a feed he opens when he
  wants, plus one summary a day.

The failure mode to design against is not missing something. It is being pinged
so often that he mutes it — and a muted channel cannot reach him on the day it
matters. An alert is worth exactly the trust that it is worth reading, and that
trust is spent every time one arrives that did not need to.

**14. Staff see what they are permitted to see.** Scoped by permission, changed
when Shoji wants, from the permission options that already exist rather than a
parallel set invented for the brief. `PERMISSION_KEYS` already governs the
admin; the brief is a view of the same business and should answer to the same
keys. A second permission system is a second place to get it wrong.

## Open

1. Nothing outstanding on Mr. Green. The build order is the next conversation.
