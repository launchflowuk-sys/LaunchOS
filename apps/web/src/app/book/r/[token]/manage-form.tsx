"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SlotView } from "@/lib/booking/slot-days";
import { cancelAction, rescheduleAction } from "../../actions";
import type { BookingActionResult } from "../../schemas";
import { SlotPicker, type SlotPickerProps } from "../../slot-picker";

/**
 * Move the call: the same picker as the booking page, keyed by the guest's
 * token, with the meeting's own old slot free to be chosen again.
 */
export function RescheduleForm({ token, picker }: { token: string; picker: Omit<SlotPickerProps, "onChange"> }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<BookingActionResult | null, FormData>(rescheduleAction, null);
  const [chosen, setChosen] = useState<SlotView | null>(null);

  useEffect(() => {
    if (state?.status === "error" && state.refresh) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} aria-label="Move the call" className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
      <input type="hidden" name="token" value={token} />
      <h2 className="mb-4 text-base font-semibold">Pick a new time</h2>
      <SlotPicker {...picker} onChange={setChosen} />
      {state?.status === "error" ? (
        <InlineAlert tone="danger" title="Not moved" className="mt-4">
          {state.message}
        </InlineAlert>
      ) : null}
      {picker.slots.length > 0 ? (
        <Button type="submit" size="lg" loading={pending} disabled={!chosen} className="mt-5 w-full">
          {chosen ? "Move to this time" : "Pick a new time first"}
        </Button>
      ) : null}
    </form>
  );
}

/**
 * Cancel the call. A native `confirm` before the action: one tap on a phone
 * must not cancel a call the guest meant to keep.
 */
export function CancelForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<BookingActionResult | null, FormData>(cancelAction, null);

  return (
    <form
      action={formAction}
      aria-label="Cancel the call"
      onSubmit={(event) => {
        if (!window.confirm("Cancel this call? You can book another time afterwards.")) event.preventDefault();
      }}
      className="rounded-xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <input type="hidden" name="token" value={token} />
      <h2 className="text-base font-semibold">Can&rsquo;t make it?</h2>
      <p className="mt-1 text-sm text-muted-foreground">Cancel the call and we will free the slot. You can book again any time.</p>
      <div className="mt-4 space-y-1.5">
        <Label htmlFor="cancel-reason">Reason (optional)</Label>
        <Textarea id="cancel-reason" name="reason" rows={2} maxLength={500} className="text-base" />
      </div>
      {state?.status === "error" ? (
        <InlineAlert tone="danger" title="Not cancelled" className="mt-4">
          {state.message}
        </InlineAlert>
      ) : null}
      <Button type="submit" variant="destructive-quiet" loading={pending} className="mt-4 w-full sm:w-auto">
        Cancel this call
      </Button>
    </form>
  );
}
