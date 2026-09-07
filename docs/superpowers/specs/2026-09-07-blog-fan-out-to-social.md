# Blog fan-out to social

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
6. **Counts.** Decide whether a fan-out post consumes the client's
   `socialPostsPerMonth` allowance or sits outside it. It changes what
   `packageUsagePressure` reports, so it is a billing question, not a cosmetic
   one. **Open — ask Shoji.**

## Constraints Shoji should hold in mind

- **Instagram cannot publish a clickable link in a feed caption.** A URL there is
  plain text. The IG variant is the image plus a "link in bio" line; the
  click-through value is Facebook's, not Instagram's.
- **These links are `nofollow` / `ugc`.** The gain is referral traffic, not SEO
  link equity. If ranking is the goal, that is internal linking, GBP posts and
  citations — a different piece of work.
- Instagram cannot publish without an image at all, so a fan-out IG post must
  reuse the blog's featured image or be sent through `content_render_image`.

## Open questions

1. Does a fan-out post count against `socialPostsPerMonth`?
2. Default offset — same day, next morning, or a few days later?
3. Both Facebook and Instagram by default, or Facebook only given the link
   limitation?
4. Should GBP fan out too? A GBP update carries a real, followed link and is
   arguably the most valuable of the three for local businesses.
