"use client";

import { useActionState } from "react";
import { OneTimePasswordDialog } from "@/components/one-time-password-dialog";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reissuePasswordAction, type ReissuePasswordState } from "./actions";

const INITIAL: ReissuePasswordState = { status: "idle" };

/**
 * Only rendered for an *active* member who is still on the password they were
 * issued, so there is nothing personal to overwrite. A pending invitation is
 * completed with "Add member", not here. The new password is shown once, in
 * this dialog, exactly like the add-member flow.
 */
export function ReissuePasswordDialog({ memberId, name }: { memberId: string; name: string }) {
  return (
    <OneTimePasswordDialog
      triggerLabel="Re-issue password"
      trigger={
        <button type="button" className="text-xs text-neutral-500 hover:text-neutral-900">
          Re-issue password
        </button>
      }
    >
      {({ close }) => <ReissuePasswordBody memberId={memberId} name={name} onClose={close} />}
    </OneTimePasswordDialog>
  );
}

/**
 * Mounted by `OneTimePasswordDialog` and remounted on every close, which is
 * what resets `useActionState` — see that component. Do not lift this state up:
 * the password shown here is *live* (re-issuing invalidates the old one and
 * signs the member out), so a reopened dialog holding the previous result would
 * hand it to whoever reaches the tab next, and a second re-issue for the same
 * member would be impossible without a full page reload.
 */
function ReissuePasswordBody({ memberId, name, onClose }: { memberId: string; name: string; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(reissuePasswordAction, INITIAL);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{state.status === "issued" ? "New password issued" : `Re-issue password for ${name}`}</DialogTitle>
      </DialogHeader>

      {state.status === "issued" ? (
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            {state.displayName} can now sign in with <span className="font-medium text-neutral-900">{state.email}</span> and
            this password. Their previous password no longer works and anyone signed in as them has been signed out. It is
            shown once and cannot be retrieved again — send it to them now and ask them to change it.
          </p>
          <p
            data-testid="one-time-password"
            className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-center font-mono text-base tracking-widest text-neutral-900"
          >
            {state.oneTimePassword}
          </p>
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="memberId" value={memberId} />
          <p className="text-sm text-neutral-600">
            This replaces {name}&apos;s password with a new one-time password, immediately invalidates the old one and signs
            out every session it opened. Use it when the password they were given never reached them.
          </p>

          {state.status === "error" ? (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Issuing…" : "Re-issue password"}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
