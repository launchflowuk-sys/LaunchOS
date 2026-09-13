# LaunchFlow paid search — built, not launched

Three campaigns for `grow.launchflow.co.uk`, ready to import into Google Ads
Editor. **Nothing here is enabled and nothing has been created in any live
account.** Import, review the proposed-changes screen, then decide.

## Read this before importing

### 1. Do not reuse the "Quote Request Submitted" conversion

Account `2078060180` (LaunchFlow UK) already has a conversion action called
**Quote Request Submitted**, whose snippet is
`AW-789899807/luoSCOq8vtIcEJ_U0_gC`. Its category is `SUBMIT_LEAD_FORM` and the
only campaign in the account is **AMO - Rendering Services**, pointing at
`amorendering.co.uk/free-quote`.

That conversion is almost certainly AMO's quote form. Wiring LaunchFlow's brief
submission into it would file LaunchFlow enquiries as AMO quote requests —
corrupting a client's conversion data and, worse, the bidding that depends on
it. **Create a new conversion action for LaunchFlow.**

Suggested settings:

| Field | Value |
| --- | --- |
| Name | `LaunchFlow — Project Brief Submitted` |
| Category | Submit lead form |
| Goal | Primary |
| Count | **One** (not Every) — one enquiry is one lead |
| Value | Leave unset, or a fixed figure you actually believe |
| Window | 30 days click, 1 day engaged-view |

Then give me the **conversion ID** (`AW-…`) and the **label** (the part after
the slash). Both, or neither is used — `send_to` with half a value is accepted
by Google and silently never counted.

### 2. The conversion has to fire once before you enable anything

Bidding with no conversion data is spending blind. Order:

1. Set `GOOGLE_ADS_CONVERSION_ID` and `GOOGLE_ADS_CONVERSION_LABEL` on
   `launchos-web`, restart.
2. Submit one real brief at `launchflow.co.uk/start`.
3. Confirm it appears in Google Ads → Goals → Conversions as **Recording
   conversions**, not just in GA4.
4. Delete the test lead from `/leads`.
5. *Then* enable the campaigns.

### 3. Pick one conversion source, not two

GA4 already fires `generate_lead`, and it can be imported into Ads. The code
also fires a direct Ads conversion. **Use one.** Both counts every enquiry
twice, and you will bid into demand that does not exist.

Recommendation: use the **direct** conversion (step 1 above) and do not import
`generate_lead`. It is the shorter path with fewer moving parts.

## What the search volume actually is

Checked against Google's own keyword planner for the UK:

| Keyword | Monthly searches | Competition |
| --- | --- | --- |
| web design essex | 210 | Low |
| website design essex | 210 | Low |
| website designers essex | 110 | Medium |
| web design agencies essex | 90 | Low |
| web development essex | 50 | Low |
| website design southend | 50 | — |
| chelmsford web design | 40 | — |

**This is a small market.** The entire local web-design search category in
Essex is roughly 800–1,000 searches a month across every variant, and you will
see a fraction of that. Expect a trickle of high-intent clicks, not volume.

What that means practically:

- **£5–8 per campaign per day is the honest ceiling.** More budget will not buy
  more clicks; there are not more clicks to buy. The budgets below reflect that.
- **Paid search is the quality channel here, not the volume channel.** For
  volume, Facebook and Instagram interest-plus-geo targeting will do far more —
  and that is already live and measured.
- Do not judge this on spend. Judge it on cost per enquiry, and not before
  ~100 clicks, which at these volumes may take a month.

## Campaign settings — apply by hand, Editor will not set these

Per campaign:

| Setting | Value |
| --- | --- |
| Type | Search only |
| **Display Network** | **OFF** |
| **Search partners** | **OFF** |
| Locations | United Kingdom, **Presence** only (not "interested in") |
| Language | English |
| Bidding | **Manual CPC** until conversions exist |
| Daily budget | see below |
| Ad schedule | Mon–Fri 07:00–21:00, Sat–Sun 09:00–20:00 |
| Auto-apply recommendations | **OFF** |

| Campaign | Daily budget | Why |
| --- | --- | --- |
| LF \| Search \| Local Web Design | £8 | Highest intent, best-understood terms |
| LF \| Search \| Business Systems | £6 | Higher value per job, lower volume, higher CPC |
| LF \| Search \| Rebuild And Improve | £5 | Cheapest clicks, least proven |

£19/day total, ~£580/month at full spend. It will almost certainly spend less.

Separate campaigns, not ad groups, purely so budget can move on evidence. If
you would never move budget between them independently, collapse them.

## Import order

Google Ads Editor, into the account you decide on:

1. `keywords.csv`
2. `responsive-search-ads.csv`
3. `negative-keywords.txt` — as a **campaign-level shared negative list**,
   applied to all three campaigns, **before** anything is enabled.

Review the proposed-changes screen. It is the only preview you get.

## After launch

- **Search terms report, weekly, for the first month.** Extend the negative
  list every single time. At these volumes one bad query can be 10% of spend.
- A campaign that spends ~20 clicks with zero enquiries gets **paused and
  read**, not more budget.
- Do not change bids and creative in the same week — you lose the ability to
  attribute the change.

## Capacity

Every enquiry here becomes a scoping conversation and then a build. Agree a
concurrent-build cap with yourself before enabling. Ad spend that outruns
delivery turns the strongest part of the offer — one team, start to finish —
into the worst part of the experience.
