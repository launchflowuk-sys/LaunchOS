import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";
import { listContentChannels } from "./channels.js";
import type { ContentChannel } from "@launchos/db/schema";
import type { ContentItemRow } from "./shared.js";

/**
 * Where a published blog post is shared, and why not everywhere.
 *
 * Facebook and Google Business Profile only. Instagram is left out on purpose:
 * a feed caption renders a URL as dead text, so an Instagram share would spend
 * a slot and a human approval on a link nobody can follow — and sending people
 * to the article is the entire point. GBP matters most of the three, because
 * its update carries a real followed link rather than a `nofollow` one.
 */
export const FAN_OUT_CHANNELS: readonly ContentChannel[] = ["facebook", "gbp"];

/** Days after the article goes live before its shares are scheduled. */
export const FAN_OUT_OFFSET_DAYS = 1;

/** 09:30 Europe/London — a share lands in the morning, not at 3am. */
const FAN_OUT_HOUR_UTC = 8;
const FAN_OUT_MINUTE = 30;

export interface FanOutResult {
  /** The drafts created, empty when there was nothing to do. */
  created: ContentItemRow[];
  /** Why nothing happened, for the timeline and for a test to read. */
  skipped?: "not_a_blog_post" | "no_permalink" | "already_fanned_out" | "no_channels";
}

/** The morning after publication, at a civilised hour. */
export function fanOutSchedule(publishedAt: Date, offsetDays = FAN_OUT_OFFSET_DAYS): Date {
  const when = new Date(publishedAt);
  when.setUTCDate(when.getUTCDate() + offsetDays);
  when.setUTCHours(FAN_OUT_HOUR_UTC, FAN_OUT_MINUTE, 0, 0);
  return when;
}

/** The words that carry the reader to the article. */
export function fanOutBody(channel: ContentChannel, title: string | null, url: string): string {
  const headline = title?.trim() || "a new post";
  if (channel === "gbp") {
    return `New on our blog: ${headline}.\n\n${url}`;
  }
  return `We've written something new — ${headline}.\n\n${url}`;
}

/**
 * Turns a just-published blog post into scheduled shares that link back to it.
 *
 * This happens **at publish time and not when the month is planned**, and that
 * is the whole design rather than an implementation detail: a blog post has no
 * URL until it is live, so at planning time there is nothing for a share to
 * point at. The Content Writer is told to link only to pages that already
 * exist, so it could never have done this itself.
 *
 * What comes out is a **draft**, not a scheduled post. Every share goes through
 * the same approval gate as anything else that reaches a client's page — rule
 * 2 — so nothing here is an outward act.
 *
 * Idempotent on `sourceItemId` + `channel`: a republish, a retry or two workers
 * racing produce one share per channel and no more.
 */
export async function fanOutPublishedPost(
  db: Db,
  organisationId: string,
  item: ContentItemRow,
  options: { offsetDays?: number; now?: Date } = {},
): Promise<FanOutResult> {
  if (item.channel !== "blog") return { created: [], skipped: "not_a_blog_post" };
  if (!item.externalUrl) return { created: [], skipped: "no_permalink" };

  const existing = await db.select({ channel: schema.contentItems.channel })
    .from(schema.contentItems)
    .where(and(
      eq(schema.contentItems.organisationId, organisationId),
      eq(schema.contentItems.sourceItemId, item.id),
      isNull(schema.contentItems.deletedAt),
    ));
  const done = new Set(existing.map((row) => row.channel));

  // Only where the client actually has that channel connected. A Facebook
  // share for a client with no Page is a draft nobody can ever approve.
  const connected = await listContentChannels(db, organisationId, { clientId: item.clientId, enabledOnly: true });
  const targets = FAN_OUT_CHANNELS
    .filter((channel) => connected.some((row) => row.channel === channel))
    .filter((channel) => !done.has(channel));

  if (targets.length === 0) {
    return { created: [], skipped: done.size > 0 ? "already_fanned_out" : "no_channels" };
  }

  const scheduledFor = fanOutSchedule(item.publishedAt ?? options.now ?? new Date(), options.offsetDays);
  const created: ContentItemRow[] = [];

  for (const channel of targets) {
    const [row] = await db.insert(schema.contentItems).values({
      organisationId,
      clientId: item.clientId,
      channel,
      kind: channel === "gbp" ? "gbp_update" : "social_post",
      status: "draft",
      periodKey: item.periodKey,
      title: item.title,
      body: fanOutBody(channel, item.title, item.externalUrl),
      linkUrl: item.externalUrl,
      imageUrl: item.imageUrl,
      scheduledFor,
      source: "agent",
      sourceItemId: item.id,
    }).returning();
    if (!row) continue;

    await recordAudit(db, organisationId, {
      actorKind: "system", action: "content_item.fanned_out",
      targetType: "content_item", targetId: row.id,
      after: { sourceItemId: item.id, channel, linkUrl: item.externalUrl },
    });
    created.push(row);
  }

  return { created };
}
