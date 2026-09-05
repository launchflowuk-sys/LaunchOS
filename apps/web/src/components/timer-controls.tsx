"use client";

import { Play, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { startTimerAction, stopTimerAction, type TimerTarget } from "@/app/(admin)/time/actions";
import type { RunningEntry } from "@/app/(admin)/time/running";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format";
import { useRunningMinutes } from "@/lib/use-running-minutes";

/**
 * "Start timer" / "Stop timer" on a task or case page.
 *
 * `running` is whatever the member is clocked on right now, wherever that is:
 * when it is this very task or case the button stops it and shows the time so
 * far; otherwise it starts one here, and the toast says what got stopped to
 * make room ("stopped timing X") — a switch is never silent.
 */
export function TimerControls({ target, running }: { target: TimerTarget; running: RunningEntry | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const here =
    running !== null &&
    ((target.taskId !== undefined && running.taskId === target.taskId) ||
      (target.ticketId !== undefined && running.ticketId === target.ticketId));
  const minutes = useRunningMinutes(here ? running.startedAt : null, here ? running.minutes : 0);

  function submit() {
    startTransition(async () => {
      const result = here ? await stopTimerAction() : await startTimerAction(target);
      if (result.status === "error") return void toast.error(result.message);
      if (result.message) toast.success(result.message);
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="secondary" loading={pending} onClick={submit} className="max-sm:w-full">
      {here ? (
        <>
          <Square aria-hidden strokeWidth={1.75} className="fill-current text-danger-fg" />
          Stop timer
          <span className="tabular-nums text-muted-foreground">{formatDuration(minutes)}</span>
        </>
      ) : (
        <>
          <Play aria-hidden strokeWidth={1.75} className="text-success-fg" />
          Start timer
        </>
      )}
    </Button>
  );
}
