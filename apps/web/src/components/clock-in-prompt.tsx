"use client";

import { Clock, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { clockInAction } from "@/app/(admin)/time/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * "Start your shift" — the first thing a staff member meets after signing in.
 *
 * A shift that has to be remembered is a shift that gets logged at four in the
 * afternoon for a day that started at nine. Somebody signing in is already at
 * their desk, which is the honest moment to record, and one press is the whole
 * interaction.
 *
 * **One button, no code.** They have just authenticated with their own
 * password; a second code proves nothing new, and a code that is shared or
 * written on a monitor proves less than nothing. It would also not stop
 * anybody clocking in from home, which is the thing a code is imagined to
 * prevent.
 *
 * The owner never sees this. Shoji is not on a shift.
 *
 * Dismissable on purpose: somebody signing in at nine at night to check one
 * thing is not starting a shift, and a dialog with no way out teaches people to
 * click the first button to make it go away — which would fill the timesheet
 * with fiction.
 */
export function ClockInPrompt({ name }: { name: string | null }) {
  const [open, setOpen] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function clockIn() {
    setError(null);
    start(async () => {
      const result = await clockInAction();
      if (result.status === "error") {
        setError(result.message ?? "That did not work. Try the clock in the top bar.");
        return;
      }
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock aria-hidden className="size-5" />
            {name ? `Morning, ${name}` : "Start your shift"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Your shift is not running yet. Starting it now records your hours from this moment — you can stop
            it any time from the clock in the top bar.
          </p>

          {error ? (
            <p role="alert" className="text-sm text-danger-fg">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Not right now
            </Button>
            <Button onClick={clockIn} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {pending ? "Starting" : "Clock in"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
