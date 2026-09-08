import { formatPence } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Money collected, month by month.
 *
 * Bars rather than a line, and CSS rather than a charting library. Six values
 * with no axes, no tooltips, no zoom and no interaction is not a chart problem
 * — it is a flexbox with heights, and a dependency here would ship a hundred
 * kilobytes to draw six rectangles.
 *
 * The tallest month sets the scale, so the shape of the year is legible even
 * when the amounts are small. A zero month still renders a stub so the axis
 * reads continuously: a gap says "no data", a flat bar says "no money", and
 * only one of those is usually true.
 */
export type RevenuePoint = { readonly month: string; readonly label: string; readonly pence: number };

export function RevenueChart({ data, className }: { data: readonly RevenuePoint[]; className?: string }) {
  if (data.length === 0) {
    return <p className={cn("text-sm text-muted-foreground", className)}>No paid invoices yet.</p>;
  }

  const peak = Math.max(...data.map((d) => d.pence));
  const latest = data[data.length - 1]!;

  return (
    <div className={className}>
      <div className="flex items-end gap-2 sm:gap-3" style={{ height: "9rem" }}>
        {data.map((point) => {
          const isLatest = point.month === latest.month;
          // A 3% floor so an empty month is still a visible tick on the axis.
          const height = peak === 0 ? 3 : Math.max(3, (point.pence / peak) * 100);
          return (
            <div key={point.month} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-2">
              <div
                className={cn(
                  "w-full rounded-t-lg transition-[height]",
                  // The current month in the action colour, the rest in a tint
                  // of it — the comparison is between months, so only one of
                  // them needs to shout.
                  isLatest ? "bg-primary" : "bg-primary/25",
                )}
                style={{ height: `${height}%` }}
                title={`${point.label}: ${formatPence(point.pence)}`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 sm:gap-3">
        {data.map((point) => (
          <span
            key={point.month}
            className={cn(
              "min-w-0 flex-1 text-center text-meta",
              point.month === latest.month ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {point.label}
          </span>
        ))}
      </div>
    </div>
  );
}
