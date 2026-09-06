import type { MeetingStatus } from "@launchos/db/schema";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { MEETING_STATUS_LABEL } from "./schemas";

/** A live call reads calm; a moved one is worth a glance; a no-show is the one that needs a follow-up. */
const TONE: Record<MeetingStatus, StatusTone> = {
  scheduled: "info",
  rescheduled: "warn",
  cancelled: "neutral",
  completed: "success",
  no_show: "danger",
};

export function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  return <StatusBadge value={status} label={MEETING_STATUS_LABEL[status]} tone={TONE[status]} />;
}
