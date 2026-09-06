"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { approveApproval, rejectApproval } from "./actions";

type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * The editable draft and the two verdicts in one form, so the text in the
 * box travels with Approve. Reject posts the same form but the action
 * ignores the body. The booking link is appended by core on send, so it is
 * shown under the box rather than pasted into it — editing it out would only
 * put it back.
 */
export function LeadReplyDecision({ approvalId, draft, bookingUrl }: { approvalId: string; draft: string; bookingUrl: string }) {
  const [pending, startTransition] = useTransition();
  const [verdict, setVerdict] = useState<"approve" | "reject" | null>(null);
  const bodyId = `lead-reply-body-${approvalId}`;
  const noteId = `lead-reply-note-${approvalId}`;

  function decide(action: (formData: FormData) => Promise<ActionResult>, kind: "approve" | "reject", form: HTMLFormElement) {
    const formData = new FormData(form);
    setVerdict(kind);
    startTransition(async () => {
      const result = await action(formData);
      setVerdict(null);
      if (result.status === "error") return void toast.error(result.message);
      toast.success(kind === "approve" ? "Reply sent" : "Draft rejected — nothing was sent");
    });
  }

  return (
    <form
      aria-label="Decide lead reply"
      className="grid gap-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        decide(approveApproval, "approve", event.currentTarget);
      }}
    >
      <input type="hidden" name="approvalId" value={approvalId} />
      <div className="space-y-1.5">
        <Label htmlFor={bodyId}>The reply — edit before sending if you like</Label>
        <Textarea id={bodyId} name="body" defaultValue={draft} rows={8} maxLength={8000} required className="text-sm" />
        <p className="text-meta break-all text-muted-foreground">
          Their booking link is added at the end: <span className="font-mono">{bookingUrl}</span>
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-64">
          <Label htmlFor={noteId} className="label-caps text-muted-foreground">
            Note (optional)
          </Label>
          <Input id={noteId} type="text" name="note" maxLength={1000} />
        </div>
        <Button type="submit" variant="success" loading={pending && verdict === "approve"} disabled={pending} className="max-sm:w-full">
          Approve and send
        </Button>
        <Button
          type="button"
          variant="destructive"
          loading={pending && verdict === "reject"}
          disabled={pending}
          className="max-sm:w-full"
          onClick={(event) => decide(rejectApproval, "reject", event.currentTarget.form!)}
        >
          Reject
        </Button>
      </div>
    </form>
  );
}
