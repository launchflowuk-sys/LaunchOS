import type { CaseStudyDeliveryStatus, CaseStudyStatus } from "@launchos/db/schema";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { CASE_STUDY_STATUS_LABEL, DELIVERY_STATUS_LABEL } from "./schemas";

/**
 * Publication and delivery are two different facts and get two different
 * pills: a build can be live while its story is a draft, and a story can be
 * published for a site still in testing.
 *
 * `unlisted` is information rather than a warning — a public URL we chose not
 * to advertise is a decision, not a problem.
 */
const STATUS_TONE: Record<CaseStudyStatus, StatusTone> = {
  draft: "neutral",
  review: "warn",
  published: "success",
  unlisted: "info",
};

export function CaseStudyStatusBadge({ status }: { status: CaseStudyStatus }) {
  return <StatusBadge value={status} label={CASE_STUDY_STATUS_LABEL[status]} tone={STATUS_TONE[status]} />;
}

const DELIVERY_TONE: Record<CaseStudyDeliveryStatus, StatusTone> = {
  live: "success",
  "in-build": "info",
  "in-testing": "warn",
  discovery: "neutral",
};

export function DeliveryStatusBadge({ status }: { status: CaseStudyDeliveryStatus }) {
  return <StatusBadge value={status} label={DELIVERY_STATUS_LABEL[status]} tone={DELIVERY_TONE[status]} />;
}
