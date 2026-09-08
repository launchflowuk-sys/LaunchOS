import { cn } from "@/lib/utils";

/** A labelled "n of m" bar. Purely presentational, safe in server components. */
export function ProgressBar({
  label,
  done,
  total,
  className,
}: {
  label: string;
  done: number;
  total: number;
  className?: string;
}) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const complete = total > 0 && done === total;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="label-caps truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
          {done} of {total} · {percent}%
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-all", complete ? "bg-success-fg" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A bar whose colour *is* the completion — red early, amber in the middle,
 * green near done.
 *
 * Separate from `ProgressBar` above rather than an option on it, because the
 * two answer different questions. That one is a labelled "4 of 9" inside a
 * detail page, where the numbers are the point and the colour would be noise.
 * This one sits in a row of projects on the dashboard, where nobody is reading
 * numbers — they are scanning for the one that is behind, and hue is the only
 * thing that survives a glance across six rows.
 *
 * The thresholds are deliberately coarse. A bar that changes shade every few
 * percent is a light show, not a signal.
 */
const STAGE_TONE = [
  { from: 67, fill: "bg-success-fg", label: "nearly there" },
  { from: 34, fill: "bg-warning-fg", label: "under way" },
  { from: 0, fill: "bg-danger-fg", label: "just started" },
] as const;

export function StageBar({
  value,
  className,
  showValue = true,
}: {
  /** 0–100, or null when the work has no plan yet — which is not the same as no progress. */
  value: number | null;
  className?: string;
  showValue?: boolean;
}) {
  if (value === null) {
    return <span className={cn("text-meta text-muted-foreground", className)}>No phases yet</span>;
  }

  const percent = Math.max(0, Math.min(100, Math.round(value)));
  const tone = STAGE_TONE.find((t) => percent >= t.from) ?? STAGE_TONE[STAGE_TONE.length - 1]!;

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${percent}% complete, ${tone.label}`}
      >
        <div className={cn("h-full rounded-full transition-[width]", tone.fill)} style={{ width: `${percent}%` }} />
      </div>
      {showValue ? (
        <span className="w-9 shrink-0 text-right text-meta font-semibold tabular-nums text-muted-foreground">{percent}%</span>
      ) : null}
    </div>
  );
}
