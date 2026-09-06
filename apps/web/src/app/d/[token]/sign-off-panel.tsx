"use client";

import { useActionState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { SignaturePad } from "@/components/signature-pad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signOffDeliveryAction } from "./actions";
import type { PublicActionResult } from "./schemas";

/**
 * The sign-off: name, email, a drawn signature and one tick.
 *
 * `/p`'s decision panel is two answers — accept, or decline with a reason —
 * because a proposal is an offer. A handover is not an offer, so there is one
 * answer here and one only. A client who is *not* happy is told to reply to
 * the email instead of being given a Reject button, because "the tiling is
 * wrong on one page" is a conversation, not a verdict, and a rejected
 * handover would be a state nothing in the product knows what to do with.
 *
 * The pad is `src/components/signature-pad.tsx` — the same component the
 * proposal page signs with, posting the same `d`-attribute path data
 * normalised to core's `0 0 600 200`. 16px fields at 44px tall, as on `/p`
 * and `/book`: this is filled in on a phone by somebody who signs one of
 * these every few years.
 */
export function SignOffPanel({ token, defaults }: { token: string; defaults: { name: string; email: string } }) {
  const [state, signOff, signing] = useActionState<PublicActionResult | null, FormData>(signOffDeliveryAction, null);

  return (
    <form action={signOff} aria-label="Sign off this handover" className="card p-6 sm:p-7">
      <input type="hidden" name="token" value={token} />
      <h2 className="h-sub">Happy with it?</h2>
      <p className="lede mt-2">
        Type your name, sign in the box and tick to confirm. Signing off is what starts your care plan — we will email
        you a signed copy straight away.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sign-off-name">Your name</Label>
          <Input id="sign-off-name" name="name" autoComplete="name" required maxLength={160} defaultValue={defaults.name} className="field" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sign-off-email">Your email</Label>
          <Input id="sign-off-email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={320} defaultValue={defaults.email} className="field" />
        </div>
      </div>

      <div className="mt-6">
        <SignaturePad name="signature" label="Sign here" />
      </div>

      <label htmlFor="sign-off-terms" className="mt-6 flex items-start gap-3 text-base">
        <input
          id="sign-off-terms"
          name="terms"
          type="checkbox"
          required
          className="mt-1 size-5 shrink-0 rounded border-2"
          style={{ accentColor: "var(--blue)", borderColor: "var(--line)" }}
        />
        <span>
          I have read this handover, the work described in it is done, and I am authorised to sign it off on behalf of
          my business.
        </span>
      </label>

      {state?.status === "error" ? (
        <InlineAlert tone="danger" title="Not signed off" className="mt-5">
          {state.message}
        </InlineAlert>
      ) : null}

      <Button type="submit" size="lg" loading={signing} className="btn btn-blue btn-lg mt-6 w-full">
        Sign off this handover
      </Button>
      <p className="mt-3 text-center text-sm" style={{ color: "var(--mute)" }}>
        Signing off records your name, your signature and the time — nothing is charged here.
      </p>
    </form>
  );
}
