"use client";

import { AlertTriangle, Database, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { removeDemoDataAction, seedDemoDataAction } from "./actions";

/**
 * The two buttons.
 *
 * Writing is one press: it removes and rewrites, so pressing it twice is safe
 * and the worst case is the same demo you already had.
 *
 * Removing asks first. Not because losing demo data matters — it is demo data
 * — but because this panel lives in the same settings area as things that are
 * not, and a delete button that never asks teaches the wrong reflex.
 */
export function DemoControls({ present }: { present: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function run(action: typeof seedDemoDataAction) {
    startTransition(async () => {
      const result = await action();
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Button type="button" onClick={() => run(seedDemoDataAction)} loading={pending} disabled={confirming}>
        <Database aria-hidden strokeWidth={1.75} className="size-4" />
        {present ? "Rewrite demo data" : "Write demo data"}
      </Button>

      {present ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="destructive" onClick={() => run(removeDemoDataAction)} loading={pending}>
              <Trash2 aria-hidden strokeWidth={1.75} className="size-4" />
              Yes, remove it all
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setConfirming(true)} disabled={pending}>
            <Trash2 aria-hidden strokeWidth={1.75} className="size-4" />
            Remove demo data
          </Button>
        )
      ) : null}

      {confirming ? (
        <p className="flex items-center gap-2 text-meta text-warning-fg">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          This cannot be undone — but you can write it again afterwards.
        </p>
      ) : null}
    </div>
  );
}
