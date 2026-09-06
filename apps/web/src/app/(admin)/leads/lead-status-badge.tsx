import type { LeadStatus } from "@launchos/db/schema";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { LEAD_STATUS_LABEL } from "./schemas";

/** `new` is the one that needs somebody: it reads as "waiting", not as calm. */
const TONE: Record<LeadStatus, StatusTone> = {
  new: "warn",
  contacted: "info",
  converted: "success",
  lost: "neutral",
};

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return <StatusBadge value={status} label={LEAD_STATUS_LABEL[status]} tone={TONE[status]} />;
}
