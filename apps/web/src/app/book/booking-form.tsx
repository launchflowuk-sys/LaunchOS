"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SlotView } from "@/lib/booking/slot-days";
import { bookAction } from "./actions";
import type { BookingActionResult } from "./schemas";
import { SlotPicker, type SlotPickerProps } from "./slot-picker";

/**
 * The whole booking: the slot picker on the left, the details on the right,
 * one submission. Name and email arrive pre-filled for a lead who followed
 * the email link or a client signed into their portal, and stay editable —
 * the guest is whoever they say they are. 16px fields at 44px tall, as on
 * `/signup`: this is filled in on a phone by somebody who has never seen
 * the product.
 *
 * A "slot taken" refusal re-reads the diary (`router.refresh`) so the time
 * that went is gone from the list rather than failing twice.
 */
export function BookingForm({
  picker,
  defaults,
  leadToken,
}: {
  picker: Omit<SlotPickerProps, "onChange">;
  defaults: { name: string; email: string };
  leadToken: string | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<BookingActionResult | null, FormData>(bookAction, null);
  const [chosen, setChosen] = useState<SlotView | null>(null);

  useEffect(() => {
    if (state?.status === "error" && state.refresh) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} aria-label="Book a call" className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      {leadToken ? <input type="hidden" name="lead" value={leadToken} /> : null}

      <div className="card min-w-0 p-6 sm:p-7">
        <h2 className="h-line mb-4">1. Choose a time</h2>
        <SlotPicker {...picker} onChange={setChosen} />
      </div>

      <div className="card min-w-0 p-6 sm:p-7">
        <h2 className="h-line">2. Your details</h2>
        <div className="mt-4 grid gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="book-name">Your name</Label>
            <Input id="book-name" name="name" autoComplete="name" required maxLength={120} defaultValue={defaults.name} className="field" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="book-email">Email</Label>
            <Input id="book-email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={320} defaultValue={defaults.email} className="field" />
            <p className="text-sm text-[var(--mute)]">The confirmation and the join link go here.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="book-notes">Anything we should know? (optional)</Label>
            <Textarea id="book-notes" name="notes" rows={4} maxLength={2000} placeholder="What the call is about, or a link to your current site." className="field min-h-24" />
          </div>
        </div>

        {state?.status === "error" ? (
          <InlineAlert tone="danger" title="Not booked" className="mt-4">
            {state.message}
          </InlineAlert>
        ) : null}

        <Button type="submit" size="lg" loading={pending} disabled={!chosen || picker.slots.length === 0} className="btn btn-ink mt-6 w-full">
          {chosen ? "Confirm the call" : "Pick a time first"}
        </Button>
        <p className="mt-3 text-center text-sm text-[var(--mute)]">
          You will get an email with the Zoom link and a link to move or cancel the call.
        </p>
      </div>
    </form>
  );
}
