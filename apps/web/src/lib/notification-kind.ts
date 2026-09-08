import {
  AlertTriangle,
  Banknote,
  Bot,
  CalendarClock,
  CheckCircle2,
  FileText,
  Globe,
  Info,
  LifeBuoy,
  type LucideIcon,
  Megaphone,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { Category } from "@/lib/categories";

/**
 * What a notification *is*, worked out from its kind.
 *
 * Every kind in this product is `<domain>.<event>` — `invoice.overdue`,
 * `site.down`, `proposal.accepted` — and there are eighty-odd of them with more
 * arriving whenever a feature lands. So nothing here is a list of kinds to keep
 * up to date: the tone comes from the event half and the category from the
 * domain half, which means a kind nobody has written yet still arrives
 * correctly coloured and filed.
 *
 * The panel this feeds used to render every one of them as identical grey
 * text, so a failed payment and a booked meeting looked the same at a glance.
 * That is the whole problem being solved: not decoration, but being able to
 * tell in one look whether anything here needs you.
 */

export type NotificationTone = "critical" | "attention" | "good" | "info";

/**
 * Matched against the event half, longest first so `send_failed` is not read as
 * a plain `sent`. Order within a tone does not matter; order *between* the
 * lists does, and it is the order they are checked in below.
 */
const CRITICAL = [
  "send_failed",
  "reply_rejected",
  "send_rejected",
  "undelivered",
  "stranded",
  "dropped",
  "escalated",
  "overdue",
  "failed",
  "error",
  "down",
  "declined",
  "expired",
  "cancelled",
  "opened",
  "settle_skipped",
  "unmatched_inbound",
  "two_factor_reset",
];

const ATTENTION = [
  "approval_requested",
  "change_requested",
  "update_requested",
  "client_review_requested",
  "requested",
  "suggested",
  "merged",
  "archived",
  "status_changed",
];

const GOOD = [
  "signed_off",
  "client_review_approved",
  "milestone_reached",
  "work_started",
  "phase_done",
  "onboarding_generated",
  "accepted",
  "approved",
  "converted",
  "completed",
  "delivered",
  "published",
  "settled",
  "paid",
  "rated",
  "sent",
];

/** `invoice.overdue` → the domain half. A kind with no dot is its own domain. */
function domainOf(kind: string): string {
  const dot = kind.indexOf(".");
  return dot === -1 ? kind : kind.slice(0, dot);
}

/** `project.client_review_requested` → `client_review_requested`. */
function eventOf(kind: string): string {
  const dot = kind.indexOf(".");
  return dot === -1 ? "" : kind.slice(dot + 1);
}

/**
 * Whether `event` contains `token` as a whole `_`-delimited word.
 *
 * A plain `includes` is what you reach for first and it is wrong: every event
 * here is snake_case, and `calibrated`, `generated`, `migrated` and
 * `integrated` all contain `rated`. That put an unknown kind — the case this
 * whole module exists to handle gracefully — into the green "good news" tone
 * on a coin flip. Matching on `_` boundaries is what makes deriving the tone
 * safe for kinds nobody has written yet.
 */
function hasToken(event: string, token: string): boolean {
  for (let from = 0; ; from += 1) {
    const at = event.indexOf(token, from);
    if (at === -1) return false;
    const startsWord = at === 0 || event[at - 1] === "_";
    const end = at + token.length;
    const endsWord = end === event.length || event[end] === "_";
    if (startsWord && endsWord) return true;
    from = at;
  }
}

export function toneOf(kind: string): NotificationTone {
  const event = eventOf(kind);
  if (CRITICAL.some((token) => hasToken(event, token))) return "critical";
  if (ATTENTION.some((token) => hasToken(event, token))) return "attention";
  if (GOOD.some((token) => hasToken(event, token))) return "good";
  return "info";
}

/**
 * Which part of the business it belongs to. Reuses the app's own category
 * vocabulary rather than inventing a second one, so a notification's icon tint
 * matches the section of the rail it would send you to.
 */
const DOMAIN_CATEGORY: Record<string, Category> = {
  invoice: "money", payment: "money", subscription: "money", proposal: "money", stripe_sync: "money",
  project: "delivery", task: "delivery", tasks: "delivery", delivery_report: "delivery",
  site: "delivery", domain: "delivery", client: "delivery", contact: "delivery",
  case_study: "delivery", content_item: "delivery", content_report: "delivery",
  ticket: "support", support: "support", incident: "support", message: "support",
  approval: "automation", agent: "automation", ops_brief: "automation", queue: "automation",
  worker: "automation", system: "automation", security: "automation",
  lead: "overview", signup: "overview", meeting: "overview",
  ad_account: "overview", ad_report: "overview", client_report: "overview",
  member: "organisation", portal: "organisation",
};

export function categoryOf(kind: string): Category {
  return DOMAIN_CATEGORY[domainOf(kind)] ?? "overview";
}

const DOMAIN_ICON: Record<string, LucideIcon> = {
  invoice: Banknote, payment: Banknote, subscription: Banknote, proposal: FileText, stripe_sync: Banknote,
  project: CheckCircle2, task: CheckCircle2, tasks: CheckCircle2, delivery_report: FileText,
  site: Globe, domain: Globe, client: Users, contact: Users,
  case_study: FileText, content_item: FileText, content_report: FileText,
  ticket: LifeBuoy, support: LifeBuoy, incident: AlertTriangle, message: LifeBuoy,
  approval: ShieldCheck, agent: Bot, ops_brief: Bot, queue: Bot,
  worker: Bot, system: AlertTriangle, security: ShieldCheck,
  lead: Megaphone, signup: Megaphone, meeting: CalendarClock,
  ad_account: Megaphone, ad_report: Megaphone, client_report: FileText,
  member: Users, portal: Users,
};

export function iconOf(kind: string): LucideIcon {
  return DOMAIN_ICON[domainOf(kind)] ?? Info;
}

/**
 * The kind in words, for the small label on the row: `stripe_sync.completed`
 * becomes "Stripe sync". It names the *source*, because the title already says
 * what happened and repeating it twice is noise.
 */
export function sourceLabel(kind: string): string {
  const domain = domainOf(kind).replaceAll("_", " ");
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

/** The stripe down the left of a row, and the ring on its icon tile. */
export const TONE_STRIPE: Record<NotificationTone, string> = {
  critical: "bg-danger-fg",
  attention: "bg-warning-fg",
  good: "bg-success-fg",
  info: "bg-border",
};

/** The icon tile. Tinted by tone, not category: urgency is what must read first. */
export const TONE_TILE: Record<NotificationTone, string> = {
  critical: "bg-danger-bg text-danger-fg",
  attention: "bg-warning-bg text-warning-fg",
  good: "bg-success-bg text-success-fg",
  info: "bg-muted text-muted-foreground",
};

/**
 * How long ago, in as few characters as possible.
 *
 * The panel used to print "8 Sept 2026, 07:00" on every row, which is eleven
 * words of chrome repeated ten times and tells you nothing you wanted: the
 * question a notification answers is "is this new", not "what was the date".
 */
export function timeAgo(value: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - value.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? "1 month ago" : `${months} months ago`;
}
