import { schema } from "@launchos/db";
import type { ContentChannel, ContentKind, ContentStatus } from "@launchos/db/schema";
import { z } from "zod";

export type ContentItemRow = typeof schema.contentItems.$inferSelect;
export type ContentBriefRow = typeof schema.contentBriefs.$inferSelect;
export type ContentChannelRow = typeof schema.contentChannels.$inferSelect;
export type ContentReportRow = typeof schema.contentReports.$inferSelect;

export const ContentChannelSchema = z.enum(schema.contentChannelEnum.enumValues);
export const ContentStatusSchema = z.enum(schema.contentStatusEnum.enumValues);
export const ActorKindSchema = z.enum(["user", "client", "agent", "system"]);

/** `YYYY-MM`. */
export const PeriodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "periodKey must be YYYY-MM");

/** The longest body any channel accepts; WordPress is the ceiling, not Facebook. */
export const MAX_CONTENT_BODY_CHARS = 20_000;
export const MAX_CONTENT_TITLE_CHARS = 200;

/** What a channel publishes. Facebook and Instagram share the social kind. */
export const KIND_FOR_CHANNEL: Record<ContentChannel, ContentKind> = {
  facebook: "social_post",
  instagram: "social_post",
  blog: "blog_post",
  gbp: "gbp_update",
};

/** How a channel's post is named in a sentence — the approval summary, the timeline. */
export const CHANNEL_LABEL: Record<ContentChannel, string> = {
  facebook: "Facebook post",
  instagram: "Instagram post",
  blog: "Blog post",
  gbp: "Google Business Profile update",
};

/** The recurring task kind that a month's slots for this channel are numbered under. */
export const TASK_KIND_FOR_CHANNEL: Record<ContentChannel, "social" | "content" | "gbp"> = {
  facebook: "social",
  instagram: "social",
  blog: "content",
  gbp: "gbp",
};

/** Statuses a person may still edit the text of. */
export const EDITABLE_STATUSES: readonly ContentStatus[] = ["draft", "awaiting_approval"];
/** Statuses an edit returns to `draft` from: the item needs another look. */
export const REVISABLE_STATUSES: readonly ContentStatus[] = ["rejected", "failed"];
/** Statuses that can still be cancelled — everything short of gone out or going out. */
export const CANCELLABLE_STATUSES: readonly ContentStatus[] = [
  "draft", "awaiting_approval", "approved", "scheduled", "failed", "rejected",
];

/** `2026-09` for a moment in time, in Europe/London. */
export function periodKeyFor(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).slice(0, 7);
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * `12 Sep`, the way the approval card names a day. Spelled by hand rather
 * than by `Intl`, whose en-GB data abbreviates September as "Sept".
 */
export function shortLondonDate(date: Date): string {
  const [, month, day] = date.toLocaleDateString("en-CA", { timeZone: "Europe/London" }).split("-").map(Number);
  return `${day} ${SHORT_MONTHS[month! - 1]}`;
}

/** `September 2026`, the way a report is headed. */
export function monthName(periodKey: string): string {
  const [year, month] = periodKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The first `max` characters on one line, with an ellipsis when cut. */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * Postgres `unique_violation`. Drizzle wraps the driver's error, so the code
 * can be on the error itself or one level down on `.cause`.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (let node: unknown = error, depth = 0; node !== null && node !== undefined && depth < 5; depth += 1) {
    if (typeof node !== "object") return false;
    const candidate = node as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505") {
      if (!constraint) return true;
      return candidate.constraint_name === constraint || candidate.constraint === constraint;
    }
    node = candidate.cause;
  }
  return false;
}

export type ContentRefusedReason =
  | "not_found"
  | "not_editable"
  | "not_cancellable"
  | "not_draft"
  | "empty_body"
  | "already_pending"
  | "not_publishing"
  | "no_active_subscription"
  | "no_package"
  | "not_portal_user";

/** A refusal the caller can turn into a sentence — the item is in the wrong state, or the client is not set up. */
export class ContentRefused extends Error {
  constructor(readonly reason: ContentRefusedReason, message: string) {
    super(message);
    this.name = "ContentRefused";
  }
}
