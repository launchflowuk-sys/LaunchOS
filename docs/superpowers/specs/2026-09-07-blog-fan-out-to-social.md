# Blog fan-out to Facebook and GBP

**Asked for:** Shoji, 6 Sep 2026 (and, he says, several times before — the earlier
asks were lost with the session context, which is what `scripts/claude-checkpoint.sh`
now exists to stop).

**Status:** specced, not built.

## The ask, in his words

> we have got posts scheduled for all the clients but at the same time we also
> schedule blog posts for all the clients, so I was questioning whether we can
> use those created blog posts to share on Facebook and Instagram, also in a
> schedule, to get traffic.

The work behind it: nine posts for three businesses, posted by hand in one day.

## What already exists

Both halves are built and real; only the join is missing.

- `content_items.channel` is one of `facebook`, `instagram`, `blog`, `gbp`, and
  `content_items.link_url` already exists on every item.
- The Meta publisher already does the right thing with a link:
  `POST /{pageId}/feed` sends `link` as the preview attachment, and
  `captionWithLink` appends the URL to the caption when it is not already in the
  body.
- Blog posts publish through `packages/integrations/src/cms` (WordPress), and
  `markPublished` records `external_url` — the blog post's permalink — at the
  moment it goes live.
- Scheduling, the approval gate and `content-publish-due` are shared by all four
  channels.

## What is missing

Nothing links one content item to another. There is no `source_item_id`, no
repurpose or cross-post path, in `core`, `agents` or `worker`; and none of the
five plan documents or two specs mention it — blog and social appear only as
separate monthly quotas (`socialPostsPerMonth`, `blogPostsPerMonth`).

It could not have happened by accident either. The Content Writer plans a whole
month up front and is told to set `linkUrl` only for a page that already exists.
A blog post has no URL until it is published, so at planning time there is
nothing to link to. **The fan-out therefore has to happen at publish time, not
at planning time.** That is the whole design.

## Design

1. **`content_items.source_item_id`** — self-referencing, nullable,
   `on delete set null`. A social post that came from a blog post knows which one.
2. **A fan-out step in `publishing.ts`**, on the transition to `published` for a
   `blog` item that captured an `external_url`: create one `draft` item per
   enabled target channel, with `link_url` set to that permalink, `source_item_id`
   set to the blog item, and `scheduled_for` offset by a configurable number of
   days so the share does not land the same minute as the post.
3. **Approval, unchanged.** The new items enter the existing gate. Nothing
   reaches a client's Page without a human tick — non-negotiable rule 2.
4. **Per-client settings**, alongside `content_channels`: whether a blog post
   fans out at all, to which channels, and the day offset(s). Off by default;
   turning it on is a decision per client.
5. **Idempotent.** A blog item that already has fan-out children creates none on
   a re-run. Keyed on `source_item_id` + `channel`.
6. **Counts: outside the allowance.** *(Shoji, 7 Sep 2026.)* A fan-out post does
   **not** spend the client's `socialPostsPerMonth`. The allowance is what the
   client pays for someone to think of and write; a share of an article they
   already paid for is not a second piece of work, and charging it twice would
   make the package look spent when it is not.

   This is not a display detail — `packageUsagePressure` decides which clients
   the Ops Brief names as over or near their limits, so counting these would
   raise false alarms every month. The allowance query must therefore exclude
   any item with a non-null `source_item_id`. Add a test that fans a blog post
   out to a client whose social allowance is already fully spent and asserts the
   client is still reported as within it.

## Constraints Shoji should hold in mind

- **Instagram cannot publish a clickable link in a feed caption.** A URL there is
  plain text. This is why Instagram is excluded from the fan-out.
- **Facebook links are `nofollow` / `ugc`.** Facebook's share returns referral
  traffic, not SEO link equity.
- **GBP is the exception, and the reason it is in scope.** A Google Business
  Profile update carries a real, followed link, so it is the one channel here
  that serves the ranking Shoji originally asked about rather than clicks alone.
- A fan-out post still needs an image. Reuse the blog's featured image where
  there is one, otherwise send it through `content_render_image`, which already
  covers both `facebook` and `gbp`.

## Decided

1. **Outside the allowance.** A fan-out post does not spend
   `socialPostsPerMonth`. See design point 6. *(Shoji, 7 Sep 2026.)*
2. **Facebook and GBP. Not Instagram.** *(Shoji, 7 Sep 2026.)* The two channels
   that can carry a link the reader can actually follow. Instagram is excluded
   deliberately: a feed caption renders a URL as dead text, so an IG share does
   nothing for the traffic this feature exists to produce, and it would spend a
   slot and an approval to say nothing clickable.

   GBP matters most of the three. Its update carries a **real, followed link**,
   so it is the only one that does anything for ranking rather than referral
   traffic alone — and most of this book is local businesses, which is exactly
   who a Google Business Profile serves.

   `IMAGE_CHANNELS` still lists instagram; nothing here changes ordinary
   Instagram posting. This is only about what a *published blog post* fans out
   to. If Instagram is ever wanted for reach rather than clicks it is one row in
   the per-client setting, not a redesign.

## Still open — proposed default, easily changed

3. **Offset: the morning after the blog post publishes.** Far enough that the
   share is not simultaneous with the article going live, close enough that it
   is still news. Per-client, so a client posting weekly can be spread wider.
