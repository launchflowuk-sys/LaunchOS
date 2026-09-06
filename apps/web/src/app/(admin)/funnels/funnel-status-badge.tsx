import type { FunnelStatus } from "@launchos/db/schema";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { FUNNEL_STATUS_LABEL } from "./schemas";

/** `published` reads as "Live" because that is what it means: an advert may point at it. */
const TONE: Record<FunnelStatus, StatusTone> = {
  draft: "neutral",
  published: "success",
  archived: "neutral",
};

export function FunnelStatusBadge({ status }: { status: FunnelStatus }) {
  return <StatusBadge value={status} label={FUNNEL_STATUS_LABEL[status]} tone={TONE[status]} />;
}
