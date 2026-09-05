"use client";

import { Clock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { clockInAction, clockOutAction } from "@/app/(admin)/time/actions";
import type { RunningEntry } from "@/app/(admin)/time/running";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format";
import { useRunningMinutes } from "@/lib/use-running-minutes";

/**
 * The clock in the admin top bar. Idle it is one button; running it is the
 * time so far, what it is against, and the way out. The duration ticks once a
 * minute from the server's own start time, and a clock-in or clock-out
 * refreshes the shell so every screen agrees.
 */
export function ClockWidget({ running }: { running: RunningEntry | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const minutes = useRunningMinutes(running?.startedAt ?? null, running?.minutes ?? 0);

  function run(action: () => Promise<{ status: "ok" | "error"; message?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.status === "error") return void toast.error(result.message);
      if (result.message) toast.success(result.message);
      router.refresh();
    });
  }

  if (!running) {
    return (
      <Button type="button" variant="secondary" size="sm" loading={pending} onClick={() => run(clockInAction)}>
        <Clock aria-hidden strokeWidth={1.75} />
        {/* Under `sm` the bar holds the menu, the search, the bell and the
            account: the label goes to screen readers only and the icon stays. */}
        <span className="max-sm:sr-only">Clock in</span>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2" data-testid="clock-running">
      <span
        className="hidden min-w-0 items-baseline gap-1.5 text-row sm:flex"
        aria-live="polite"
        title={running.label ? `Timing ${running.label}` : "Clocked in"}
      >
        <span className="font-medium tabular-nums">{formatDuration(minutes)}</span>
        <span className="hidden max-w-40 truncate text-muted-foreground lg:inline">
          {running.label ? `on ${running.label}` : "clocked in"}
        </span>
      </span>
      <Button type="button" variant="secondary" size="sm" loading={pending} onClick={() => run(clockOutAction)}>
        <Clock aria-hidden strokeWidth={1.75} className="text-success-fg" />
        <span className="max-sm:sr-only">Clock out</span>
      </Button>
    </div>
  );
}
