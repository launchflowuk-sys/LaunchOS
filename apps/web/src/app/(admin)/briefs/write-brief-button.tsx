"use client";

import { Sunrise } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { writeBriefAction } from "./actions";

/**
 * Queues a brief for now. The agent writes it in the worker, so the page does
 * not change on the spot: the toast says where the result lands (the bell,
 * and this screen on the next visit).
 */
export function WriteBriefButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      loading={pending}
      className="max-sm:w-full"
      onClick={() =>
        startTransition(async () => {
          const result = await writeBriefAction();
          if (result.status === "error") return void toast.error(result.message);
          toast.success("Queued. The Ops Brief agent is writing it now — you will be notified when it is ready.");
        })
      }
    >
      <Sunrise aria-hidden strokeWidth={1.75} />
      Write today&apos;s brief
    </Button>
  );
}
