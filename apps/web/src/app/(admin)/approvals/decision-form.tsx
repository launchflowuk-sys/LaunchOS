"use client";

import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * `useFormStatus` only reports the status of the form it is rendered inside,
 * so the button has to be its own component.
 */
function SubmitButton({
  label,
  pendingLabel,
  variant,
}: {
  label: string;
  pendingLabel: string;
  variant: "success" | "destructive";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} loading={pending} className="max-sm:w-full">
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
  variant,
  withNote,
  resumesAgent,
}: {
  approvalId: string;
  action: (formData: FormData) => Promise<ActionResult>;
  label: string;
  /** `success` releases the action; `destructive` refuses it. */
  variant: "success" | "destructive";
  withNote?: boolean;
  resumesAgent?: boolean;
}) {
  const noteId = `approval-note-${variant}-${approvalId}`;

  return (
    <form
      className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end"
      aria-label={`${label} approval`}
      action={async (formData) => {
        const result = await action(formData);
        if (result.status === "error") return void toast.error(result.message);
        toast.success(resumesAgent ? "Decision recorded — resuming the agent" : "Decision recorded");
      }}
    >
      <input type="hidden" name="approvalId" value={approvalId} />
      {withNote ? (
        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-64">
          <Label htmlFor={noteId} className="label-caps text-muted-foreground">
            {label} note (optional)
          </Label>
          <Input id={noteId} type="text" name="note" maxLength={1000} />
        </div>
      ) : null}
      <SubmitButton label={label} pendingLabel={resumesAgent ? "Resuming…" : "Saving…"} variant={variant} />
    </form>
  );
}
