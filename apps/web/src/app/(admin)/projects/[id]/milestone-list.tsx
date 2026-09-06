import type { ProjectMilestoneRow, ProjectPhaseRow } from "@launchos/core";
import { CheckCircle2, Flag } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { addMilestoneAction, reachMilestoneAction, setMilestoneVisibilityAction } from "../actions";

/**
 * The promises on a project — "the booking form takes a card" — and the moment
 * one of them is kept.
 *
 * A milestone has two states and no `status` column: a nullable `reached_at`
 * records both, plus the day, which the Friday update needs anyway. Reaching
 * one emails the client the same day, so the button says what it will do and
 * core refuses the second click rather than sending twice.
 *
 * `client_visible` is the switch that keeps our own bookkeeping off their page.
 * It is shown on every row rather than hidden behind an edit screen, because
 * the cost of getting it wrong is a client reading something meant for us.
 */
export function MilestoneList({
  projectId,
  milestones,
  phases,
}: {
  projectId: string;
  milestones: readonly ProjectMilestoneRow[];
  phases: readonly ProjectPhaseRow[];
}) {
  const phaseName = new Map(phases.map((phase) => [phase.id, phase.name]));

  return (
    <>
      {milestones.length === 0 ? (
        <EmptyState icon={Flag}>
          No milestones yet. They are what a client recognises — a phase is our vocabulary, a milestone is theirs.
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {milestones.map((milestone) => (
            <li key={milestone.id} className="min-w-0 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words">{milestone.title}</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    {phaseName.get(milestone.phaseId ?? "") ?? "No step"}
                    {milestone.targetDate ? ` · due ${formatDate(`${milestone.targetDate}T12:00:00Z`)}` : ""}
                    {milestone.reachedAt ? ` · reached ${formatDate(milestone.reachedAt)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {milestone.clientVisible ? null : <StatusBadge value="internal" tone="neutral" label="Internal" />}
                  <StatusBadge
                    value={milestone.reachedAt ? "reached" : "outstanding"}
                    tone={milestone.reachedAt ? "success" : "neutral"}
                    label={milestone.reachedAt ? "Reached" : "Outstanding"}
                  />
                </div>
              </div>
              {milestone.detail ? <p className="mt-2 text-sm break-words text-muted-foreground">{milestone.detail}</p> : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {milestone.reachedAt ? null : (
                  <ActionForm action={reachMilestoneAction} success="Milestone reached — the client will be told today" className="max-sm:w-full">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="milestoneId" value={milestone.id} />
                    <Button type="submit" variant="success" size="sm" className="max-sm:w-full">
                      <CheckCircle2 aria-hidden />
                      Mark reached
                    </Button>
                  </ActionForm>
                )}
                <ActionForm
                  action={setMilestoneVisibilityAction}
                  success={milestone.clientVisible ? "Hidden from the client" : "Shown to the client"}
                  className="max-sm:w-full"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="milestoneId" value={milestone.id} />
                  <input type="hidden" name="clientVisible" value={milestone.clientVisible ? "false" : "true"} />
                  <Button type="submit" variant="ghost" size="sm" className="max-sm:w-full">
                    {milestone.clientVisible ? "Hide from the client" : "Show to the client"}
                  </Button>
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-xl border bg-card p-4">
        <ActionForm
          action={addMilestoneAction}
          success="Milestone added"
          resetOnSuccess
          ariaLabel="Add a milestone"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="milestone-title">Milestone</Label>
            <Input id="milestone-title" name="title" required maxLength={300} placeholder="Booking form takes a card" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="milestone-phase">Step</Label>
            <NativeSelect id="milestone-phase" name="phaseId" defaultValue="">
              <option value="">No step</option>
              {phases.map((phase) => (
                <option key={phase.id} value={phase.id}>
                  {phase.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="milestone-date">Target date</Label>
            <Input id="milestone-date" name="targetDate" type="date" />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="milestone-detail">Detail</Label>
            <Textarea id="milestone-detail" name="detail" rows={2} maxLength={4000} placeholder="One line the client will read on their progress page." />
          </div>
          <div className="flex flex-col justify-end gap-3">
            <Label htmlFor="milestone-visible" className="gap-2">
              <input
                id="milestone-visible"
                name="clientVisible"
                type="checkbox"
                defaultChecked
                className="size-4 rounded-[4px] border border-input accent-primary"
              />
              Show to the client
            </Label>
            <Button type="submit" variant="secondary" className="w-full">
              Add milestone
            </Button>
          </div>
        </ActionForm>
      </div>
    </>
  );
}
