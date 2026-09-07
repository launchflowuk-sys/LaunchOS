import type { PhaseTaskCounts, ProjectPhaseRow } from "@launchos/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setPhaseStatusAction } from "../actions";
import { PhaseStatusBadge } from "../project-status-badge";
import { PHASE_STATUS_LABEL, PHASE_STATUSES } from "../schemas";

/**
 * The spine: brief, design, build, review, launch, care, down a rail.
 *
 * Vertical rather than a row of chips because a phase carries three facts —
 * where it got to, when, and how much work sits under it — and six of those
 * across a phone is a scroll bar. The marker on the rail is the state at a
 * glance; the pill spells it out for a greyscale print and a colour-blind
 * reader.
 *
 * Phases are not a state machine. Any status may follow any other, so the
 * control is a picker rather than a "next step" button: Shoji runs design and
 * build together, skips review on a one-page site, and occasionally has to put
 * a finished step back.
 */

const MARKER: Record<ProjectPhaseRow["status"], string> = {
  pending: "border-border bg-card",
  active: "border-primary bg-primary",
  done: "border-success-fg bg-success-fg",
  skipped: "border-border bg-muted",
};

export function PhaseSpine({
  projectId,
  clientId,
  phases,
  tasksByPhase,
}: {
  projectId: string;
  /** For the "see the tasks" link, which filters the Tasks list by client. */
  clientId: string;
  phases: readonly ProjectPhaseRow[];
  tasksByPhase: Record<string, PhaseTaskCounts>;
}) {
  if (phases.length === 0) {
    return <EmptyState>This project has no steps. Every project usually starts with the six standard ones.</EmptyState>;
  }

  return (
    <ol className="relative grid gap-3 pl-7">
      {/* One hairline behind the markers. `aria-hidden` because the order is
          already carried by the list. */}
      <span aria-hidden className="absolute left-[9px] top-3 bottom-3 w-px bg-border" />
      {phases.map((phase) => {
        const counts = tasksByPhase[phase.id];
        return (
          <li key={phase.id} className="relative min-w-0">
            <span aria-hidden className={cn("absolute -left-7 top-4 size-[11px] rounded-full border-2", MARKER[phase.status])} />
            <div className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-base font-semibold">{phase.name}</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    {/* A skipped step reads as itself. Core stamps `started_at`
                        the first time a phase leaves `pending` — skipping
                        included — and "Started 6 Sept · not needed" is a
                        sentence about our bookkeeping, not about the job. */}
                    {phase.status === "skipped"
                      ? "Not part of this project"
                      : phase.startedAt
                        ? `Started ${formatDate(phase.startedAt)}`
                        : "Not started"}
                    {phase.status !== "skipped" && phase.doneAt ? ` · finished ${formatDate(phase.doneAt)}` : ""}
                    {counts && counts.total > 0 ? ` · ${counts.done} of ${counts.total} tasks done` : ""}
                  </p>
                </div>
                <PhaseStatusBadge status={phase.status} />
              </div>

              <ActionForm
                action={setPhaseStatusAction}
                success={`${phase.name} updated`}
                ariaLabel={`Move ${phase.name}`}
                className="mt-3 flex flex-wrap items-end gap-2"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="phaseId" value={phase.id} />
                <label htmlFor={`phase-${phase.id}`} className="sr-only">
                  {phase.name} status
                </label>
                <NativeSelect key={phase.status} id={`phase-${phase.id}`} name="status" defaultValue={phase.status} className="w-full sm:w-48">
                  {PHASE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {PHASE_STATUS_LABEL[status]}
                    </option>
                  ))}
                </NativeSelect>
                <Button type="submit" variant="secondary" size="sm" className="max-sm:w-full">
                  Save
                </Button>
                {counts && counts.total > 0 ? (
                  <Link
                    href={`/clients/${clientId}/tasks`}
                    className="text-meta text-muted-foreground hover:text-foreground max-sm:w-full sm:ml-auto"
                  >
                    See the tasks
                  </Link>
                ) : null}
              </ActionForm>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
