import type { ContentChannel, ContentKind, ContentStatus } from "@launchos/db/schema";
import { Facebook, Globe, Instagram, type LucideIcon, MapPin } from "lucide-react";
import { StatusBadge, type StatusTone } from "@/components/status-badge";

/**
 * How a channel, a kind and a status read on screen. Shared by the admin list,
 * the item page, the client tab and the approval card so a Facebook post is
 * named the same way everywhere.
 */
export const CHANNEL_NAME: Record<ContentChannel, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  blog: "Blog",
  gbp: "Google Business Profile",
};

export const CHANNEL_ICON: Record<ContentChannel, LucideIcon> = {
  facebook: Facebook,
  instagram: Instagram,
  blog: Globe,
  gbp: MapPin,
};

export const KIND_LABEL: Record<ContentKind, string> = {
  social_post: "Social post",
  blog_post: "Blog post",
  gbp_update: "GBP update",
};

/**
 * The content statuses that are not already in `StatusBadge`'s shared map
 * (`draft`, `awaiting_approval`, `approved`, `published`, `failed`, `rejected`
 * and `cancelled` are). `scheduled` and `publishing` are on their way out —
 * calm, not a warning.
 */
const CONTENT_TONE: Partial<Record<ContentStatus, StatusTone>> = {
  scheduled: "info",
  publishing: "info",
};

export function ContentStatusBadge({ status }: { status: ContentStatus }) {
  const tone = CONTENT_TONE[status];
  return tone ? <StatusBadge value={status} tone={tone} /> : <StatusBadge value={status} />;
}

/** The channel's icon and name on one line: "◉ Facebook". */
export function ChannelLabel({ channel }: { channel: ContentChannel }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
      {CHANNEL_NAME[channel]}
    </span>
  );
}
