import { describeProgress, getProject, listProjects, type ProjectDetail } from "@launchos/core";
import { Check, CheckCircle2, Circle, MinusCircle } from "lucide-react";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Where the client's build has actually got to.
 *
 * Everything printed here comes from `projectProgress` and `describeProgress`
 * in core. The rule — every step that is going to happen and every milestone
 * is one unit, a unit counts when it is finished, never 100% before sign-off —
 * is written down once, in one function, and this page prints it. It does not
 * compute a percentage of its own and must never start.
 *
 * The breakdown sits beside the number on purpose: a bar on its own invites
 * "out of what?", and being able to answer that is the whole reason the number
 * can be trusted.
 *
 * Internal milestones are filtered here. `getProject` returns every one
 * because the admin page needs them; `client_visible` is the switch staff use
 * to keep our own bookkeeping off this page, and honouring it is this
 * component's job.
 */

const STEP_ICON = { done: CheckCircle2, skipped: MinusCircle, active: Circle, pending: Circle } as const;
const STEP_TONE = {
  done: "text-success-fg",
  skipped: "text-muted-foreground",
  active: "text-primary",
  pending: "text-muted-foreground/60",
} as const;

const STEP_NOTE = {
  done: "Finished",
  active: "Under way",
  pending: "To come",
  skipped: "Not needed on this project",
} as const;

export async function ClientProjects({ organisationId, clientId }: { organisationId: string; clientId: string }) {
  const db = getDb();
  const projects = await listProjects(db, organisationId, { clientId, limit: 10 });
  if (projects.length === 0) return null;

  // One `getProject` per project — four statements each, and a client has one
  // or two builds. It is the same read the admin page uses, so the number the
  // client sees and the number Shoji sees cannot drift.
  const details = await Promise.all(projects.map((project) => getProject(db, organisationId, project.id)));

  return (
    <>
      {details
        .filter((detail): detail is ProjectDetail => detail !== null)
        .map((detail) => (
          <ProjectPanel key={detail.project.id} detail={detail} />
        ))}
    </>
  );
}

function ProjectPanel({ detail }: { detail: ProjectDetail }) {
  const { project, phases, progress } = detail;
  const milestones = detail.milestones.filter((milestone) => milestone.clientVisible);

  const description = project.deliveredAt
    ? `Handed over on ${formatDate(project.deliveredAt)}.`
    : project.targetDate
      ? `We are aiming for ${formatDate(`${project.targetDate}T12:00:00Z`)}.`
      : project.summary;

  return (
    <Section title={project.name} {...(description ? { description } : {})}>
      <div className="rounded-xl border bg-card p-4 sm:p-5">
        <ProgressHeadline percent={progress.percent} delivered={progress.delivered} description={describeProgress(progress)} label={project.name} />

        {phases.length > 0 ? (
          <ol className="mt-6 grid gap-3">
            {phases.map((phase) => {
              const Icon = STEP_ICON[phase.status];
              return (
                <li key={phase.id} className="flex items-start gap-3">
                  <Icon aria-hidden strokeWidth={1.75} className={cn("mt-0.5 size-5 shrink-0", STEP_TONE[phase.status])} />
                  <div className="min-w-0">
                    <p className={cn("text-base", phase.status === "done" ? "font-medium" : "")}>{phase.name}</p>
                    <p className="text-meta text-muted-foreground">
                      {STEP_NOTE[phase.status]}
                      {phase.doneAt ? ` · ${formatDate(phase.doneAt)}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}

        {milestones.length > 0 ? (
          <div className="mt-6 border-t pt-5">
            <p className="label-caps text-muted-foreground">What we promised</p>
            <ul className="mt-3 grid gap-2.5">
              {milestones.map((milestone) => (
                <li key={milestone.id} className="flex items-start gap-3">
                  <span
                    aria-label={milestone.reachedAt ? "Done" : "Not yet"}
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px]",
                      milestone.reachedAt ? "bg-success-fg text-white" : "border border-input",
                    )}
                  >
                    {/* A plain tick, the same mark the proof checklists below use. */}
                    {milestone.reachedAt ? <Check aria-hidden strokeWidth={3} className="size-3" /> : null}
                  </span>
                  <div className="min-w-0">
                    <p className={cn("text-base", milestone.reachedAt ? "text-muted-foreground" : "")}>{milestone.title}</p>
                    {milestone.detail ? <p className="text-sm text-muted-foreground">{milestone.detail}</p> : null}
                    {milestone.reachedAt ? (
                      <p className="text-meta text-muted-foreground">Done {formatDate(milestone.reachedAt)}</p>
                    ) : milestone.targetDate ? (
                      <p className="text-meta text-muted-foreground">Aiming for {formatDate(`${milestone.targetDate}T12:00:00Z`)}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * The number, the sentence behind it, and the bar.
 *
 * Its own bar rather than `PortalProgress`, which counts finished items out of
 * a total: this one is already a percentage from core, and passing it as
 * "97 of 100" would put an invented total in front of the client.
 */
function ProgressHeadline({
  percent,
  delivered,
  description,
  label,
}: {
  percent: number;
  delivered: boolean;
  description: string;
  label: string;
}) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="text-base text-muted-foreground">{description}</p>
        <p className={cn("text-figure font-semibold tabular-nums", delivered ? "text-success-fg" : "text-primary")}>{percent}%</p>
      </div>
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-all", delivered ? "bg-success-fg" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </>
  );
}
