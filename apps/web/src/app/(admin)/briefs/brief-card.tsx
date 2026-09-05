import type { OpsBrief } from "@launchos/core";
import { Sunrise } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Highlights } from "./brief-article";
import { briefDateLabel, briefExcerpt } from "./format";

/** How much of the brief the dashboard shows before pointing at the whole thing. */
const EXCERPT_LINES = 3;

/**
 * "This morning's brief" on the dashboard: the day, the first lines, what
 * needs you, and the way to the rest. The latest brief whatever its date —
 * a missed morning shows yesterday's rather than nothing.
 */
export function BriefCard({ brief }: { brief: OpsBrief | null }) {
  if (!brief) {
    return (
      <EmptyState
        icon={Sunrise}
        action={
          <Button asChild variant="secondary" size="sm">
            <Link href="/briefs">Open Briefs</Link>
          </Button>
        }
      >
        No brief yet. The Ops Brief agent writes one at 07:00 each morning; you can write today&apos;s from Briefs.
      </EmptyState>
    );
  }

  const lines = briefExcerpt(brief.bodyMd, EXCERPT_LINES);

  return (
    <div className="rounded-xl border bg-card p-4 sm:p-5" data-testid="brief-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="label-caps text-muted-foreground">{briefDateLabel(brief.briefDate)}</p>
          <div className="mt-2 space-y-1 text-sm">
            {lines.map((line, index) => (
              <p key={index} className={index === 0 ? "font-medium" : "text-muted-foreground"}>
                {line}
              </p>
            ))}
          </div>
        </div>
        <Button asChild variant="secondary" size="sm" className="shrink-0 max-sm:w-full">
          <Link href="/briefs">Read the brief</Link>
        </Button>
      </div>
      <div className="mt-4">
        <Highlights items={brief.highlights} compact />
      </div>
    </div>
  );
}
