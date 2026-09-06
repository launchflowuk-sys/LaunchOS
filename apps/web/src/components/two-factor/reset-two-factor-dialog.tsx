"use client";

import { Fragment, useActionState, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * What the reset actions return. Declared structurally, like `ActionForm`'s
 * own result type, so this component stays independent of either module's
 * `actions.ts` — Team and the client's Portal users screen each own an action
 * that revalidates its own path and both pass it in as a prop.
 */
export type ResetTwoFactorState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; email: string; emailed: boolean };

const INITIAL: ResetTwoFactorState = { status: "idle" };

/**
 * Takes somebody else's second factor off, from the row that names them.
 *
 * Only rendered for an account that actually has one, and only for an owner —
 * the service refuses everything else anyway, but a control that is always
 * there and usually fails is worse than no control.
 *
 * The whole form lives behind `key={round}` for the same reason
 * `OneTimePasswordDialog` remounts its body: the field in it holds the owner's
 * own password, and a closed dialog that reopens still carrying it would hand
 * a typed password to whoever reaches the tab next. Closing throws the mounted
 * state away rather than clearing it by hand.
 */
export function ResetTwoFactorDialog({
  userId,
  name,
  action,
  enforced = false,
}: {
  /** The `user.id` behind the row, not the membership id: the factor is on the account. */
  userId: string;
  name: string;
  action: (previous: ResetTwoFactorState, formData: FormData) => Promise<ResetTwoFactorState>;
  /** True when this organisation requires a second factor of its team. */
  enforced?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);

  function close() {
    setOpen(false);
    setRound((current) => current + 1);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        {/* `destructive-quiet`: the same action once per row of a list, never
            the one decisive red button on the screen. */}
        <Button type="button" variant="destructive-quiet" size="sm" className="max-sm:w-full">
          Reset two-factor
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <Fragment key={round}>
          <ResetBody userId={userId} name={name} action={action} enforced={enforced} onClose={close} />
        </Fragment>
      </DialogContent>
    </Dialog>
  );
}

function ResetBody({
  userId,
  name,
  action,
  enforced,
  onClose,
}: {
  userId: string;
  name: string;
  action: (previous: ResetTwoFactorState, formData: FormData) => Promise<ResetTwoFactorState>;
  enforced: boolean;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  if (state.status === "done") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Two-factor reset</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{state.email}</span> no longer has a second factor. They sign
            in with their password alone until they set one up again, and every device that was signed in as them has
            been signed out.
          </p>
          {state.emailed ? (
            <InlineAlert tone="success">They have been emailed to say it happened and who did it.</InlineAlert>
          ) : (
            <InlineAlert tone="warning">
              The email telling them could not be sent. Tell them yourself — nobody should lose a second factor without
              hearing about it.
            </InlineAlert>
          )}
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Reset two-factor for {name}</DialogTitle>
      </DialogHeader>
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="userId" value={userId} />

        <p className="text-sm text-muted-foreground">
          This removes the authenticator and the backup codes from {name}&apos;s account. They will be able to sign in
          with their password alone, every device signed in as them is signed out, and they are emailed to say it
          happened.{" "}
          {enforced
            ? "Because the team requires two-factor, they will be asked to set it up again the next time they sign in."
            : "They will be asked to set one up again the next time two-factor is required of them."}{" "}
          Use it when somebody has lost both their phone and their backup codes.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor={`reset-2fa-password-${userId}`}>Confirm your own password</Label>
          <Input
            id={`reset-2fa-password-${userId}`}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
          <p className="text-meta text-muted-foreground">
            A live session is not enough on its own — a laptop somebody walked off with must not be able to do this.
          </p>
        </div>

        {state.status === "error" ? <InlineAlert tone="danger">{state.message}</InlineAlert> : null}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" loading={pending}>
            Reset two-factor
          </Button>
        </div>
      </form>
    </>
  );
}
