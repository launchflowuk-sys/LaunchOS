"use client";

import { Check } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { updateTaskStatusAction } from "../actions";

/**
 * The one button that closes a task, and the reason it cannot yet.
 *
 * `missing` is core's own list of sentences (`evidenceSatisfied`), rendered
 * word for word so the button and the refusal `updateTaskStatus` would give
 * say the same thing. Disabled is not hidden: the person doing the work needs
 * to see what is still owed, not wonder where the button went.
 */
export function MarkDoneButton({
  taskId,
  status,
  satisfied,
  missing,
}: {
  taskId: string;
  status: string;
  satisfied: boolean;
  missing: readonly string[];
}) {
  const reasonId = useId();
  if (status === "done" || status === "cancelled") return null;
  const reason = missing.length > 0 ? `Still needed: ${missing.join("; ")}.` : null;

  return (
    <form
      action={async (formData) => {
        const result = await updateTaskStatusAction(formData);
        if (result.status === "error") toast.error(result.message);
        else toast.success("Task done");
      }}
      className="grid gap-1.5"
      aria-label="Mark done"
    >
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="status" value="done" />
      <Button
        type="submit"
        disabled={!satisfied}
        aria-describedby={reason ? reasonId : undefined}
        title={reason ?? undefined}
        className="max-sm:w-full"
      >
        <Check aria-hidden strokeWidth={1.75} />
        Mark done
      </Button>
      {reason ? (
        <p id={reasonId} className="text-meta text-warning-fg">
          {reason}
        </p>
      ) : null}
    </form>
  );
}
