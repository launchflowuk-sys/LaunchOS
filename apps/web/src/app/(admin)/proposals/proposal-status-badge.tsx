import type { ProposalStatus } from "@launchos/db/schema";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { PROPOSAL_STATUS_LABEL } from "./schemas";

/**
 * `sent` and `viewed` are the two that are waiting on somebody else, so they
 * read as information rather than as a problem. `expired` is the one that
 * costs money quietly — a price nobody said no to and nobody can say yes to —
 * so it carries the danger colour beside `declined`.
 */
const TONE: Record<ProposalStatus, StatusTone> = {
  draft: "neutral",
  sent: "info",
  viewed: "warn",
  accepted: "success",
  declined: "danger",
  expired: "danger",
};

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return <StatusBadge value={status} label={PROPOSAL_STATUS_LABEL[status]} tone={TONE[status]} />;
}
