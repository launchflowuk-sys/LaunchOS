import { cn } from "@/lib/utils";

/**
 * "n of m done", as a label and a bar.
 *
 * The portal has its own copy rather than sharing `components/progress-bar`
 * because that one is the admin's — it still carries the pre-design-system
 * greys, and the two surfaces read the same figure to different people: staff
 * want the count, a client wants reassurance that something is moving.
 *
 * The bar is `success` when everything in the phase is finished and `primary`
 * while it is in flight, so a completed run of work is legible at a glance
 * without reading the numbers.
 */
export function PortalProgress({
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
      {/* The phase name is the section heading above this, so the bar carries
          only the count and takes the heading as its accessible name. */}
      <p className="mb-1.5 text-meta tabular-nums text-muted-foreground">
        {done} of {total} done · {percent}%
      </p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
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
