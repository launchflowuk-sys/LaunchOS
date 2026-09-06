import type { ProjectPhaseStatus, ProjectStatus } from "@launchos/db/schema";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { PHASE_STATUS_LABEL, PROJECT_STATUS_LABEL } from "./schemas";

/**
 * `on_hold` is the one that costs money quietly — a build nobody is working on
 * and nobody has closed — so it carries the warning colour rather than the
 * calm grey `cancelled` gets. `delivered` is success; `planned` is neutral
 * because nothing is wrong with a project that has not started yet.
 */
const PROJECT_TONE: Record<ProjectStatus, StatusTone> = {
  planned: "neutral",
  active: "info",
  on_hold: "warn",
  delivered: "success",
  cancelled: "neutral",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <StatusBadge value={status} label={PROJECT_STATUS_LABEL[status]} tone={PROJECT_TONE[status]} />;
}

/**
 * A skipped step is neutral, not a warning: the client brought their own
 * design, which is a fact about the job rather than something to fix.
 */
const PHASE_TONE: Record<ProjectPhaseStatus, StatusTone> = {
  pending: "neutral",
  active: "info",
  done: "success",
  skipped: "neutral",
};

export function PhaseStatusBadge({ status }: { status: ProjectPhaseStatus }) {
  return <StatusBadge value={status} label={PHASE_STATUS_LABEL[status]} tone={PHASE_TONE[status]} />;
}
