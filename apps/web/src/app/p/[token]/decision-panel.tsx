"use client";

import { useActionState, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { acceptProposalAction, declineProposalAction } from "./actions";
import type { PublicActionResult } from "./schemas";
import { SignaturePad } from "./signature-pad";

/**
 * The decision: accept, or decline with a reason.
 *
 * Accepting is the loud path and declining is the quiet one — a disclosure
 * under the accept card rather than a second button beside it. Both are real
 * answers we want, but a client on a phone should have to mean it before they
 * say no, and nobody should have to hunt for the yes.
 *
 * 16px fields at 44px tall, as on `/book` and `/signup`: this is filled in on
 * a phone by somebody who has never seen the product and will not see it again.
 */
export function DecisionPanel({
  token,
  defaults,
  termsGiven,
}: {
  token: string;
  defaults: { name: string; email: string };
  /** True when the proposal carries terms of its own, so the tick can name them. */
  termsGiven: boolean;
}) {
  const [acceptState, accept, accepting] = useActionState<PublicActionResult | null, FormData>(acceptProposalAction, null);
  const [declineState, decline, declining] = useActionState<PublicActionResult | null, FormData>(declineProposalAction, null);
  const [showDecline, setShowDecline] = useState(false);

  return (
    <div className="grid gap-6">
      <form action={accept} aria-label="Accept this proposal" className="card p-6 sm:p-7">
        <input type="hidden" name="token" value={token} />
        <h2 className="h-sub">Happy with this?</h2>
        <p className="lede mt-2">
          Type your name, sign in the box and tick the terms. We will email you a countersigned copy straight away.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="accept-name">Your name</Label>
            <Input id="accept-name" name="name" autoComplete="name" required maxLength={160} defaultValue={defaults.name} className="field" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="accept-email">Your email</Label>
            <Input id="accept-email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={320} defaultValue={defaults.email} className="field" />
          </div>
        </div>

        <div className="mt-6">
          <SignaturePad name="signature" label="Sign here" />
        </div>

        <label htmlFor="accept-terms" className="mt-6 flex items-start gap-3 text-base">
          <input
            id="accept-terms"
            name="terms"
            type="checkbox"
            required
            className="mt-1 size-5 shrink-0 rounded border-2"
            style={{ accentColor: "var(--blue)", borderColor: "var(--line)" }}
          />
          <span>
            I have read and agree to {termsGiven ? "the terms set out in this proposal" : "the scope and the price set out above"}, and I
            am authorised to accept it on behalf of my business.
          </span>
        </label>

        {acceptState?.status === "error" ? (
          <InlineAlert tone="danger" title="Not accepted" className="mt-5">
            {acceptState.message}
          </InlineAlert>
        ) : null}

        <Button type="submit" size="lg" loading={accepting} className="btn btn-blue btn-lg mt-6 w-full">
          Accept this proposal
        </Button>
        <p className="mt-3 text-center text-sm" style={{ color: "var(--mute)" }}>
          Accepting records your name, your signature and the time — nothing is charged here.
        </p>
      </form>

      <div className="text-center">
        {showDecline ? null : (
          <button type="button" className="tlink tlink-quiet" onClick={() => setShowDecline(true)}>
            Not for us — decline this proposal
          </button>
        )}
      </div>

      {showDecline ? (
        <form action={decline} aria-label="Decline this proposal" className="card p-6 sm:p-7">
          <input type="hidden" name="token" value={token} />
          <h2 className="h-line">Declining</h2>
          <p className="mt-2 text-base" style={{ color: "var(--mute)" }}>
            No hard feelings. If you tell us why, it helps us quote better next time — but it is optional.
          </p>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="decline-reason">Why? (optional)</Label>
            <Textarea id="decline-reason" name="reason" rows={3} maxLength={2000} className="field min-h-24" placeholder="Too much for us just now, going with someone else, the timing is wrong…" />
          </div>

          {declineState?.status === "error" ? (
            <InlineAlert tone="danger" title="Not recorded" className="mt-4">
              {declineState.message}
            </InlineAlert>
          ) : null}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <Button type="submit" loading={declining} className="btn btn-white">
              Decline the proposal
            </Button>
            <Button type="button" className="btn btn-white" onClick={() => setShowDecline(false)}>
              Keep thinking about it
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
