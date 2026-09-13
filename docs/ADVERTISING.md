# Advertising: the landing page, attribution and conversions

How a paid click becomes a lead you can see, and what is measured along the way.

```
advert → grow.launchflow.co.uk → launchflow.co.uk/start → brief submitted
         (apps/grow, nginx)      (apps/web, the funnel)   (the conversion)
```

## 1. The landing page

`grow.launchflow.co.uk` is `apps/grow` — an nginx container serving eight
static files, built by `infra/Dockerfile.grow`. It is not a route in the Next
app. The page is an approved design and the bytes are the specification;
porting it to JSX and scoping its global CSS away from the live marketing site
would have risked changing something that was signed off, for no gain. See
`apps/grow/README.md`.

All seven enquiry buttons point at `https://launchflow.co.uk/start`. `app.js`
rewrites each one with the campaign tags from the current URL, through a strict
allow-list, with no cookie and no storage:

`utm_source` `utm_medium` `utm_campaign` `utm_term` `utm_content` `utm_id`
`fbclid` `gclid` `gbraid` `wbraid` `msclkid` `ttclid`

With JavaScript off the buttons still work; the tags are simply not carried.

## 2. Attribution, and where it used to be lost

Forwarding a tag to `/start` proves nothing on its own. Three things had to be
true for a campaign to reach the lead, and none of them were:

**The funnel only recorded five UTM tags.** `safeSource` allowed
`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` and
`entry_route`. A Facebook or Google advert very often delivers a click with no
UTM tags at all — auto-tagging puts `gclid`, `gbraid`, `wbraid` or `fbclid` on
the URL instead — so a paid click was recorded as a direct visit. The
allow-list now carries every identifier above, plus the referring host.

**Nothing copied the draft's source onto the lead.** `captureLeadFromDraft`
created the row and never touched `metadata.attribution`, which is what the
leads board's Campaign column, the `utmCampaign` filter and
`costPerLeadByCampaign` all read. Every lead the brief funnel ever created
showed a blank. `packages/core/src/brief-funnel/lead-attribution.ts` maps the
draft's flat snake_case source onto the camelCase shape
`LeadAttributionSchema` validates, and capture writes it on creation.

**A returning visitor's campaign was dropped entirely.** The source is read in
`POST /api/brief-funnel/session`, which only runs when there is no draft. The
cookie lasts thirty days, so somebody who clicked an advert, got as far as
their phone number, closed the tab and clicked a second advert a week later
arrived with `GET /session` returning the draft they already had — and the
second click was invisible. `POST /api/brief-funnel/touch` now records it.

### First touch and latest touch

Two facts, kept apart, because a returning ad click should neither rewrite
history nor be thrown away:

| | Where | Meaning |
| --- | --- | --- |
| First touch | `leads.metadata.attribution` | The visit that opened the draft. The acquisition. Never overwritten |
| Latest touch | `leads.metadata.attributionLatest` | The most recent campaign the same person returned on |

On the draft these live in one flat `source` object; the latest-touch keys
carry a `latest_` prefix. An `entry_route` on its own is never a touch —
otherwise reopening a bookmark would look like a second campaign.

The marketing site's own `lf_attr` cookie — used by `/contact`, `/signup` and
the `/f/<slug>` funnels — gained the same click identifiers, so the two paths
into a lead record the same things.

## 3. Conversions

**The primary milestone is a brief the backend has confirmed.** One place
reports it: `funnel.tsx`, immediately after `/api/brief-funnel/submit` returns
a reference. Not a button press, not reaching the last step, not rendering the
thank-you screen — each of those fires for people who never enquired, and an ad
platform told to optimise for them will go and buy more of them.

There were no existing campaigns and no existing analytics when this was
chosen, so nothing was changed silently.

| Event | Where | When |
| --- | --- | --- |
| `funnel_cta_click` / `FunnelCtaClick` | Landing page | An enquiry button is followed. **Secondary.** Never a lead |
| `generate_lead` (GA4) | `/start` | `/submit` returned a reference |
| Google Ads `conversion` | `/start` | The same moment, via `send_to` |
| Meta `Lead` | `/start` | The same moment, `eventID` = the brief reference |

**Early contact capture is unchanged and still happens.** A lead is written the
moment there is a valid email or phone, long before the last screen. That is
the funnel's whole point and choosing submission as the advertising milestone
does not weaken it — it is simply not what the ad platforms are told to buy.

**Deduplication.** The brief reference is the key. It is stable, the server
minted it, and `/submit` is idempotent, so a retry returns the same one. A
`localStorage` guard stops a re-render or a back navigation counting twice.
Meta deduplicates browser and server copies of one event on matching
`event_name` **and** `event_id` — a Conversions API sender added later must use
`Lead` and this same reference. No revenue value is assigned: an enquiry is not
a sale, and inventing a number teaches Smart Bidding a lie.

**Choose one Google Ads conversion source.** Either import the GA4
`generate_lead` conversion into Ads, or use the direct `send_to` above. Doing
both counts every enquiry twice. `GOOGLE_ADS_CONVERSION_ID` and
`GOOGLE_ADS_CONVERSION_LABEL` are unset, so today neither is active.

## 4. Consent

There was no analytics and no consent banner in this codebase before now.
Both surfaces default to denied under Google Consent Mode v2, ask, and remember
the answer. A refusal still loads the Google tag for its cookieless ping;
Meta is not loaded at all. Nothing appears until an id is configured — the page
a visitor sees today is exactly the approved one.

Consent is stored per origin, so a visitor who accepts on
`grow.launchflow.co.uk` is asked again on `launchflow.co.uk`. Browsers do not
share `localStorage` between hostnames and this is deliberately not worked
around with a shared-domain cookie.

## 5. Configuration

Every variable is optional and everything is off until they are set.

| Where | Variable |
| --- | --- |
| `launchos-web` | `GA4_MEASUREMENT_ID`, `META_PIXEL_ID`, `GOOGLE_ADS_CONVERSION_ID`, `GOOGLE_ADS_CONVERSION_LABEL` |
| The landing-page app | `GROW_GA4_ID`, `GROW_META_PIXEL_ID`, `GROW_ADS_CONVERSION_ID` |

Not `NEXT_PUBLIC_`: Next inlines those at build time, which would make
correcting a mistyped pixel id a rebuild. These are read on the server and
passed to the client component as props, so a change is a Coolify variable and
a restart. A malformed value is ignored rather than fatal.

The landing page is static, so its three are substituted into `tracking.js` by
`envsubst` at container start.

## 6. Still outstanding

- **The account ids above.** Nothing is invented; there is no GA4 property,
  pixel or Ads conversion action referenced anywhere in this repository.
- **Meta Conversions API.** Browser-side `Lead` carries the event id that makes
  a server copy deduplicate, but no server sender exists. It needs a dataset id
  and an access token, server-side only.
- **DNS for `grow.launchflow.co.uk`,** and the Coolify application described in
  `apps/grow/README.md`.
- **Whether the landing page should be indexable.** It is today, with a
  self-canonical, as the handover brief specifies. It is close enough to the
  homepage in substance that leaving it in the index may cannibalise
  `launchflow.co.uk` in organic search; `noindex, follow` would end that and
  costs a paid landing page nothing.
