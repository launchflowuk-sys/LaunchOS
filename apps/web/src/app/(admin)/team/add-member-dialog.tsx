"use client";

import { useActionState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { NativeSelect } from "@/components/ui/native-select";
import { OneTimePasswordDialog, OneTimePassword } from "@/components/one-time-password-dialog";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addMemberAction, type AddMemberState } from "./actions";

const INITIAL: AddMemberState = { status: "idle" };

export function AddMemberDialog() {
  return (
    <OneTimePasswordDialog triggerLabel="Add member">
      {({ close }) => <AddMemberBody onClose={close} />}
    </OneTimePasswordDialog>
  );
}

/**
 * Mounted by `OneTimePasswordDialog` and remounted on every close, which is
 * what resets `useActionState` — see that component. Do not lift this state up:
 * a second "Add member" would otherwise reopen on the previous member's
 * one-time password with no form at all.
 */
function AddMemberBody({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(addMemberAction, INITIAL);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{state.status === "created" ? "Member added" : "Add team member"}</DialogTitle>
      </DialogHeader>

      {state.status === "created" ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {state.displayName} can sign in with <span className="font-medium text-foreground">{state.email}</span> and this
            one-time password. It is shown once and cannot be retrieved again — send it to them now and ask them to change it.
          </p>
          <OneTimePassword value={state.oneTimePassword} />
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="member-display-name">Full name</Label>
            <Input id="member-display-name" name="displayName" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-email">Email address</Label>
            <Input id="member-email" name="email" type="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-title">Job title</Label>
            <Input id="member-title" name="title" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-role">Role</Label>
            <NativeSelect id="member-role" name="role" defaultValue="staff">
              <option value="staff">Staff</option>
              <option value="owner">Owner</option>
            </NativeSelect>
          </div>

          {state.status === "error" ? <InlineAlert tone="danger">{state.message}</InlineAlert> : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create member
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
