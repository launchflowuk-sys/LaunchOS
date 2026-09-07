# Pricing, packages and the public page

**Status:** research done, structure proposed, four decisions outstanding.
**Asked for:** Shoji, 7 Sep 2026, ~03:00.

## The problem, in his words

The pricing page shows prices pulled from Stripe. Those are bespoke subscriptions
negotiated with individual clients years ago — real numbers, wrong audience. He
started with Starter / Standard / Premium when the business was manual WordPress
builds; the extras accreted as the work changed. Now the page confuses the
people it is meant to convert. He wants a floor around £45/month for low-traffic
local businesses and the ability to show serious numbers to businesses that
turn over real money, and he intends to win on price because his cost base will
be Pakistan.

## What the market actually charges (researched 7 Sep 2026)

**Pay-monthly websites — his direct competitors on the floor**

| Provider | From |
|---|---|
| Lollipop Rocks | £25/mo |
| Inventis | £29/mo |
| Monthly Web Design | £50/mo |
| Ubie | £69/mo |

The field runs roughly **£19–£145/month**. "No upfront fee" is now standard,
not a differentiator. Most tie the client to 12–24 months, and on many plans the
client never owns the site — stop paying and it comes down.

**Website care plans**

| Tier | Monthly |
|---|---|
| Budget / automated, ticket queue | £20–£40 |
| Typical small-business WordPress | £40–£120 |
| Local specialist, human attention | £80–£200 |
| Agency with strategy + account management | £200–£500+ |

**Marketing retainers (UK SME)** — £1,250–£3,500/month core; SEO alone
£1,500–£5,000+; social £800–£3,000.

## The uncomfortable finding

**£45 is not a low price in this market. It is the middle.** Competitors are at
£25 and £29. Undercutting is not available as a strategy at the floor — someone
is always cheaper, and racing them wins the customers who leave over £5.

The gap worth attacking is higher up. A business paying an agency **£1,250 a
month** for content and SEO is the one who would change supplier for a
materially better price — and that is the band where LaunchOS's automation and
his cost base actually compound.

So: **the floor is for credibility and volume, not margin. The money is in the
middle band, priced at a quarter of what agencies charge for the same output.**

## Proposed structure — three products, not one grid

The page's real fault is not too many numbers. It is numbers aimed at
incompatible audiences in one table: £45 tells a £2m business "not for you", and
£800 sends the plumber away. Separate them.

**1. Presence — from £45/mo.** The floor. Site, hosting, SSL, backups, uptime
monitoring, a bounded number of small changes, client portal. Published price.
For the plumber, the barber, the takeaway.

**2. Growth — £150–£400/mo.** Everything in Presence plus the work agencies
charge £1,250+ for: monthly content, blog posts fanned out to Facebook and GBP
(see [[2026-09-07-blog-fan-out-to-social]]), GBP updates, reporting through the
portal, ads managed. Published price. **This is the tier the business should
live on.**

**3. Applications — quoted.** Cabio-class builds: dispatch, booking, portals,
anything with a database and a login. Setup priced per project, then a monthly
platform fee. Published as "from £X, scoped on a call" — never a bare number.

Niche does not become its own price list; that is what produces a confusing
grid. Niche shows up in the **case studies and the words** — a taxi firm, a
glazing installer, a tuition academy — against the same three tiers.

## Why not publish the ceiling

Price is a signal as much as a number. Publish £2,000 and the plumber leaves;
publish £45 to a business turning over £2m a month and they read it as risk,
not value, and do not enquire at any price. Affordable floor published, serious
tier published, enterprise quoted, is the shape that holds both.

The cost-base advantage is real and should be spent on **including more at each
tier**, not on being the cheapest — competitors cannot include monthly content
and reporting at £45 because a human has to do it. LaunchOS's agents do. That is
the moat, and it is worth more than £5 off.

## Stripe

Legacy prices stay untouched — existing clients keep billing exactly as they
are. Create a **fresh set of public Products and Prices**, and have the page
render only those, selected explicitly rather than by listing everything in the
account. Build the catalogue in **test mode first** so the whole thing can be
reviewed before anything touches live. `STRIPE_SECRET_KEY` is already set on
both Coolify resources, so no new credential is needed.

## Decided, 7 Sep 2026 — the ladder

Content, social and GBP is **£65/month**. With that, every published price is
the sum of its parts, which is why these three numbers and not a range:

| Tier | What is in it | Monthly |
|---|---|---|
| **Presence** | Site, hosting, backups, monitoring, portal | **£45** |
| **Standard** | Presence + content, social and GBP | **£110** |
| **Growth** | Standard + ad management | **£220** |
| **Applications** | Cabio-class builds | quoted |

Two things this fixes. £45 + £65 is **£110**, which fell just under the £120
Growth floor first proposed — site-plus-content had nowhere to sit, and it is
the shape most local businesses actually want. And a published range makes a
reader wait for a call; three numbers let them decide on the page, which is the
entire point of the exercise.

Each step roughly doubles and buys one clear thing: a site, then a voice, then
traffic. Anything above Growth — a second site, ads on a second brand — is
quoted from the components, and lands £265–£350, inside the band Shoji named.

**Set against the market:** agencies charge £800–£3,000/month for social
management alone. Standard is £110 for that *plus* the website. The gap is not
a discount, it is the agents in this repo doing the work — which is why it can
be held rather than merely offered.

## The AMO client, and the component prices hiding inside it

The one piece of real evidence in the business. AMO pays **£200/month** for two
websites — AMO Rendering and AMO Services — plus ad management on Rendering
only. Adding ads for Services would be **+£100**.

That decomposes cleanly against the tiers, which is the useful part:

| | |
|---|---|
| 2 × Presence @ £45 | £90 |
| Ad management, one business | **£110** |
| **Total** | **£200** |

And his own "+£100 for the second" corroborates it. So the business is already
pricing ad management at **£100–£110 per business per month** consistently,
without anyone having written it down. That is the number to build proposals
from — not a new invention, a description of what he already does.

**Implied component list** (internal, for quoting; the page shows packages):

| Component | Monthly |
|---|---|
| Website / Presence, per site | £45 |
| Content + social + GBP, per business | £65 |
| Ad management, per business | £100–£110 |

Two sites plus ads for both = £290, which lands inside Growth's £120–£350
without any special pleading. The band was chosen well.

**Multi-site and multi-brand is a real pattern, not an edge case.** AMO is one
owner with two trading names. The second site costs LaunchOS almost nothing —
same client, same portal, same relationship — so a discount there is genuine
margin, not a giveaway.

**The discount is not published.** Shoji's decision, and the right one: the page
carries list prices, and the reduction for a second site or a second set of ads
is offered *in the conversation*, where it is worth something. The proposal
system already carries this — lines are free-text with their own prices, so a
quote can say "second site, discounted" as its own line and the client sees the
saving explicitly against list.

## Decisions still needed

1. **What exactly does £45 buy?** It must be bounded — how many small changes a
   month, and what counts as small — or it becomes a support sink that loses
   money on the clients least able to pay more.
2. **Setup fees — keep, or fold into the monthly?** Proposals already support
   setup + monthly, one-off, and monthly-on-delivery. Folding them in matches
   the "no upfront fee" the whole pay-monthly field now advertises, but it
   costs cash flow he does not currently have.
3. **Minimum term?** The field standard is 12–24 months. He wants retention
   through being worth staying with, which argues for no lock-in — but that is
   a real revenue risk to take deliberately rather than by default.
*(Content + social + GBP was the fourth of these. Answered: £65.)*

## Sources

- https://lollipoprocks.co.uk/
- https://www.inventis.co.uk/pay-monthly-website-design/
- https://monthlywebdesign.com/
- https://ubiewebsites.co.uk/
- https://redeagle.tech/blog/wordpress-care-plans-uk
- https://luxbranding.co.uk/website-maintenance-cost-uk/
- https://whito.co.uk/research/uk-agency-retainers/
- https://ukwebworks.co.uk/digital-marketing-retainer-pricing-uk-a-no-nonsense-2026-guide/
