"use client";

import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * `useFormStatus` only reports the status of the form it is rendered inside,
 * so the button has to be its own component.
 */
function SubmitButton({ label, pendingLabel, destructive }: { label: string; pendingLabel: string; destructive?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

/**
 * Approve / Reject. The decision itself is recorded on the approval row before
 * the action returns; for an approval that belongs to an agent run, the resume
 * it queues carries on afterwards in the worker, and the button says so. An
 * approval with no run behind it (an invoice send) has nothing to resume, so it
 * must not claim otherwise — the work is finished when the toast appears.
 */
export function DecisionForm({
  approvalId,
  action,
  label,
  destructive,
  withNote,
  resumesAgent,
}: {
  approvalId: string;
  action: (formData: FormData) => Promise<ActionResult>;
  label: string;
  destructive?: boolean;
  withNote?: boolean;
  resumesAgent?: boolean;
}) {
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={`${label} approval`}
      action={async (formData) => {
        const result = await action(formData);
        if (result.status === "error") return void toast.error(result.message);
        toast.success(resumesAgent ? "Decision recorded — resuming the agent" : "Decision recorded");
      }}
    >
      <input type="hidden" name="approvalId" value={approvalId} />
      {withNote ? (
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Decision note (optional)
          <input
            type="text"
            name="note"
            maxLength={1000}
            className="h-8 w-72 rounded-md border border-neutral-300 px-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
          />
        </label>
      ) : null}
      <SubmitButton
        label={label}
        pendingLabel={resumesAgent ? "Resuming…" : "Saving…"}
        {...(destructive ? { destructive: true } : {})}
      />
    </form>
  );
}
