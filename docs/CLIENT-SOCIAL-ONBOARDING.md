# Connecting a client's social accounts

What LaunchOS needs from a client before it can post for them, and what has to
be true on LaunchFlow's side first.

Checked against the live production token on 14 Sep 2026, not from the docs.
Revised the same day: the two gates, the system-user asset step, and Standard
Access before App Review.

## The short version

**From the client you need one thing: access to their Facebook Page.** Not a
password, not a token, no Instagram login. Everything else is derived or is
LaunchFlow's own problem.

**But there are two separate gates, and confusing them wastes days.**

| Gate | Granted how | How often |
| --- | --- | --- |
| The app may *use* a permission | added to the Meta app, once | **once, for every client, for ever** |
| The token may *reach one account* | the asset is in LaunchFlow's portfolio **and assigned to the system user** | once per client |

Adding `instagram_content_publish` to the app does not give access to a single
Instagram account. It gives the app the *right to ask*. Which accounts it can
ask about is decided entirely by the second gate. So one permission grant
covers every client LaunchFlow will ever have — and every client still has to
hand over their Page individually.

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
LaunchFlow's Business portfolio ID — `925233161834616` — → tick the Page → give **Content** access.

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

### Instagram: the permissions are done, and **no App Review was needed**

Settled by testing rather than by reading, on 14 Sep 2026. The system-user
token now carries `instagram_basic`, `instagram_content_publish`,
`instagram_manage_comments`, `instagram_manage_insights` and
`instagram_manage_messages`, all at **Standard Access**, with no App Review
and no Business Verification — the portfolio still shows
`verification_status: None`.

So the earlier conclusion in this file was wrong in the expensive direction:
it would have cost a week of screencasts and written use cases for something
that took one dashboard visit. Standard Access covers assets the app's own
portfolio owns or is a Partner on, which is every case LaunchFlow has.

Advanced Access and App Review remain the answer only for reaching accounts
with no relationship to the portfolio — which is not a thing LaunchFlow does.

**What is left is not permissions.** It is the two per-Page steps below.

To fix, in the Meta app dashboard (app `1454866403356430`):

1. Add `instagram_basic` and `instagram_content_publish` to the app. The
   button may read **+ Add** or **Add to App Review** depending on which
   version of the dashboard is served; both do the same thing, and neither
   submits anything. A submission only happens when the use-case form is
   filled in and **Submit for review** is pressed.
2. **Try Standard Access first.** Standard Access is what `ads_management`
   runs on in production today, and it covers assets the app's own Business
   portfolio owns or has been made a Partner on — which is exactly this case.
   **Advanced Access** — and therefore Business Verification and App Review —
   is for reaching accounts that have no relationship with the app's business.
   Meta's documentation and Meta's actual behaviour do not always agree on
   where publishing sits, so this is a question to settle with one API call
   rather than by reading. If it fails, the error text is what the review
   submission should be written against.
3. **Regenerate the system-user token** afterwards. Adding a permission to the
   app does not add it to a token that already exists, and this is the step
   that gets missed: the review passes, nothing changes, and the cause is a
   stale token.

### The step that is nobody's job and breaks everything

**A system user does not inherit the portfolio's assets.** Each Page has to be
assigned to it by hand:

> Business Settings → **Users → System Users** → the user → **Add Assets** →
> Pages → tick the Page → **Manage Page** / Content

This is almost certainly why exactly one Page is reachable today. Being a Page
admin personally is not the same thing, and neither is the client having
granted Partner access — the grant puts the Page in the portfolio, and this
step puts it in the token's reach. A client who has done everything right
still publishes nothing until this is done, and the failure looks identical to
a missing permission.

Shoji's own Pages — Thurrock Tuition Academy, Grays CabLine, Mobile PC Doctor
— skip the Partner step entirely and still need this one. They are the right
place to prove the pipeline: no client waiting, and no client watching.

### Google Business Profile: not configured, and it is sold

`GBP_CLIENT_ID`, `GBP_CLIENT_SECRET` and `GBP_REFRESH_TOKEN` are all unset, so
the GBP publisher is not active. Its own OAuth, separate from Meta.

**This one is commercial, not cosmetic.** Standard (£110) and Growth (£220)
both promise four Google Business updates a month, so until those three values
exist that part of both plans cannot run.

The first two come from the Google Cloud console — enable the Google Business
Profile API on a project, then Credentials → OAuth client ID → **Desktop app**.
The third cannot be copied from anywhere: a refresh token is only issued after
a human consents in a browser. So:

    pnpm gbp:token -- --client-id=<id> --client-secret=<secret>

It prints a consent URL, listens on a loopback port, exchanges the code and
prints the refresh token. Sign in as the Google account that will hold Manager
access on clients' listings. Nothing is written to disk — paste all three into
Coolify on **web and worker** and restart both.

Two things that make people think they have done it wrong:

- The consent URL must carry `access_type=offline` **and** `prompt=consent`.
  Without the first there is no refresh token at all; without the second an
  account that has consented before is sent back without one. The command
  sets both.
- Enabling the API can need approval from Google and take days. Start that
  before anything else.

## Where it currently stands

Measured against the live token on 14 Sep 2026, after the new token landed.

| | |
| --- | --- |
| LaunchFlow Business portfolio | `925233161834616` — **this is the ID clients need** |
| System user | `launchos` (`122100159885476252`), token does not expire |
| Instagram permissions on the token | **all five present, Standard Access, no App Review** |
| Pages **owned** by the portfolio | **1** — AMO Rendering (`1348180978370412`) |
| Pages **shared** via Partner access | **0** |
| Pages assigned to the system user | **1** — AMO Rendering |
| Instagram accounts linked to any Page | **0** |
| Instagram publishing possible today | **No** — not for want of permission; there is no Instagram account linked to a Page |
| GBP | Not configured |

So the ceiling is no longer Meta's. It is that only one Page has ever been
put in the portfolio, and that Page has no Instagram attached. Both are
dashboard work measured in minutes.

### The two steps, per Page

1. **Get the Page into the portfolio.** Own pages:
   `business.facebook.com/settings/pages` → **Add → Claim a Page** (instant
   when you are already its admin). Client pages: they add you as a Partner
   with the ID above.
2. **Assign it to the system user.** Business Settings → Users → System Users
   → `launchos` → **Add Assets** → Pages → tick it → Manage Page.

Then link the Instagram account to that Page, and LaunchOS reads the
Instagram id off the Page itself.

Thurrock Tuition Academy, Grays CabLine and Mobile PC Doctor are all Shoji's
own and none of them are in the portfolio yet. They are the right place to
prove Instagram publishing: no client waiting, and no client watching.

## The email to send a client

> To let us post to your Facebook and Instagram, we need two things — no
> passwords, and nothing that gives us access to your personal account.
>
> **1. Facebook Page access.** In Meta Business Suite go to
> Settings → Partners → Add Partner, enter `925233161834616`, tick
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

## If Instagram should do everything it can

The two above are the minimum: read the account, publish to it. What each
further permission buys, in the order worth adding them:

| Permission | What it unlocks | Worth it when |
| --- | --- | --- |
| `instagram_basic` | read the account and its media | **required** |
| `instagram_content_publish` | publish feed posts, carousels, reels, stories | **required** |
| `instagram_manage_comments` | read, reply to, hide and delete comments | as soon as a client has any engagement — an unanswered comment is a lost enquiry, and this is what turns comments into support cases |
| `instagram_manage_insights` | reach, impressions, profile views, follower demographics | the monthly client report stops being a list of what was posted and becomes a list of what it did |
| `instagram_manage_messages` | read and send Instagram DMs | the salon in the demo takes every booking by DM. This is where that goes into the LaunchOS inbox instead of a phone |
| `pages_manage_metadata` | subscribe the Page to webhooks | comments and DMs arrive as they happen rather than whenever a poll runs |
| `pages_messaging` | send as the Page | needed in practice alongside `instagram_manage_messages` |
| `business_management` | read the portfolio's assets | client Pages get discovered instead of typed in by hand |

Not worth adding: `instagram_shopping_tag_products` (no client sells online)
and the `instagram_branded_content_*` family (no influencer work). An unused
permission on an app is a question to answer at the next review, so the list
should stay as short as the work allows.

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
