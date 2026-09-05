import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The loading shape of a DataList: the same bordered card, the same row rhythm,
 * so a Suspense fallback does not resize the page when the rows arrive.
 *
 * The bars are decoration; the status message is what a screen reader gets.
 */
export function SkeletonRows({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={cn("rounded-xl border bg-card", className)}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0" aria-hidden>
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              key={column}
              className={cn("h-3.5 flex-1 rounded-full", column === 0 && "max-w-[36%] flex-[2]")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
