# Connecting a client's social accounts

What LaunchOS needs from a client before it can post for them, and what has to
be true on LaunchFlow's side first.

Checked against the live production token on 14 Sep 2026, not from the docs.

## The short version

**From the client you need one thing: access to their Facebook Page.** Not a
password, not a token, no Instagram login. Everything else is derived or is
LaunchFlow's own problem.

That is because LaunchOS does not hold per-client credentials. It holds **one**
Meta app and **one** system-user token (`META_ADS_ACCESS_TOKEN`,
`META_ADS_APP_SECRET` — shared with the Ads integration on purpose: two tokens
for one app is two things to lose). Per client it stores a single
`content_channels` row: the channel and the Page's id. The page-specific token
is fetched per post from `GET /{pageId}?fields=access_token`.

## What to ask a client for

### Facebook — required

They add LaunchFlow as a **Partner** on their Facebook Page, with **Manage
Page / Create content** access.

In *their* Meta Business Suite: **Settings → Partners → Add Partner** →
LaunchFlow's Business portfolio ID → tick the Page → give **Content** access.

If they have no Business portfolio, the simpler route is to add Shoji as a
**Page admin** and the Page gets claimed into LaunchFlow's portfolio from
there. Partner access is cleaner — it survives them changing staff, and it does
not put a person in the middle.

Then you need the **Page ID**. It is in Business Suite under the Page's
details, or the numeric id in the Page URL. That is the only value typed into
LaunchOS.

### Instagram — required, and the part clients get wrong

Two things must be true, and **both are the client's to fix**:

1. Their Instagram must be a **Business** or **Creator** account. Not personal.
   Instagram → Settings → Account type.
2. It must be **linked to the Facebook Page** above. Business Suite → Settings
   → Instagram accounts → Connect.

**No API can post to a personal Instagram account. Ever.** That is Meta's rule,
not a LaunchOS limitation, and there is no workaround worth discussing. If a
client will not convert the account, Instagram is off the table for them.

Once both are true you need **nothing else from them** — `instagram-lookup`
reads the Instagram Business id straight off the Page, so nobody has to go
digging in Business Suite for it.

### Google Business Profile — optional

They add LaunchFlow's Google account as a **Manager** on their Business
Profile. Not Owner; Manager is enough to post and it leaves them in control.

## What has to be true on LaunchFlow's side

This is where the actual work is, and it is not per client.

### Facebook: working

The live system-user token carries `pages_manage_posts`,
`pages_read_engagement` and `pages_show_list`. Facebook posting works today.

### Instagram: blocked, and this is the blocker

The same token carries **neither `instagram_basic` nor
`instagram_content_publish`**. Until both are on it, Instagram publishing
cannot work for anybody — and that has nothing to do with what clients have
or have not connected.

To fix, in the Meta app dashboard (app `1454866403356430`):

1. Add `instagram_basic` and `instagram_content_publish` to the app.
2. Both need **Advanced Access**, which means **Business Verification** and
   **App Review**. Budget days, not minutes — Meta asks for a screencast of the
   publishing flow and a written use case.
3. **Regenerate the system-user token** afterwards. Adding a permission to the
   app does not add it to a token that already exists, and this is the step
   that gets missed: the review passes, nothing changes, and the cause is a
   stale token.

### Google Business Profile: not configured

`GBP_CLIENT_ID`, `GBP_CLIENT_SECRET` and `GBP_REFRESH_TOKEN` are all unset, so
the GBP publisher is not active. Its own OAuth, separate from Meta.

## Where it currently stands

| | |
| --- | --- |
| Pages reachable by the token | **1** — AMO Rendering (`1348180978370412`) |
| Client channels connected in LaunchOS | **1** — AMO Rendering, Facebook |
| Instagram accounts connected | **0** |
| Instagram possible at all | **No** — token lacks both permissions |
| GBP | Not configured |

So the pipeline is proven on one Page and one channel. Nothing is wrong with
it; it simply has not been given anything else to post to.

## The email to send a client

> To let us post to your Facebook and Instagram, we need two things — no
> passwords, and nothing that gives us access to your personal account.
>
> **1. Facebook Page access.** In Meta Business Suite go to
> Settings → Partners → Add Partner, enter `<LaunchFlow Business ID>`, tick
> your Page and give Content access.
>
> **2. Instagram linked to that Page.** Your Instagram needs to be a Business
> or Creator account (Instagram → Settings → Account type), and connected to
> the Page in Business Suite → Settings → Instagram accounts. Instagram does
> not allow scheduled posting to personal accounts, so this step is required
> rather than a preference.
>
> That is everything. We never see your login, and you can remove our access at
> any time from the same Partners screen.

## Things that will bite later

- **Instagram needs a publicly reachable image URL.** It cannot take an upload:
  the flow is create a media container pointing at a URL, then publish it. A
  post whose image sits behind auth fails at the container step.
- **50 Instagram posts per rolling 24 hours, per account.** Fine for a content
  calendar, not fine for a backfill.
- **An Instagram caption cannot be edited after publishing.** Facebook's can.
  So the approval gate matters more for Instagram than Facebook.
- **Removing partner access breaks posting silently.** A client who tidies
  their Partners list stops publication with a permissions error and no warning
  beforehand, so treat a publish failure on one client as possible access loss
  rather than a bug.
