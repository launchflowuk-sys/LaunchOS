import type { ProjectProgress } from "@launchos/core";
import { cn } from "@/lib/utils";

/**
 * The one number, and the sentence that defends it.
 *
 * `describeProgress` is printed beside the percentage rather than under a
 * tooltip because a number on its own invites "out of what?", and the honest
 * answer is the whole argument for the number. Nothing on this screen may
 * compute a percentage of its own: `projectProgress` in core is the rule, and
 * a second one here would be a second rule.
 */
export function ProgressPanel({
  progress,
  description,
  className,
}: {
  progress: ProjectProgress;
  /** `describeProgress(progress)`, resolved by the caller so this stays presentational. */
  description: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 sm:p-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <p className="label-caps text-muted-foreground">Progress</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <p className="text-figure font-semibold tabular-nums text-category-delivery">{progress.percent}%</p>
      </div>
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Project progress"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-all", progress.delivered ? "bg-success-fg" : "bg-primary")}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      {!progress.delivered && progress.unitsTotal > 0 && progress.unitsDone === progress.unitsTotal ? (
        <p className="mt-2 text-meta text-muted-foreground">
          Everything planned is ticked off. It stays at 99% until you deliver it — the client reads 100% as finished.
        </p>
      ) : null}
    </div>
  );
}
