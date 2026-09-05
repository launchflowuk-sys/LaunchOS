"use client";

import { useActionState, useId } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { OneTimePasswordDialog } from "@/components/one-time-password-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { invitePortalUserAction, type InviteState } from "./actions";

/**
 * Same shape as the Team screen's one-time-password dialog: the password lives
 * only in the dialog body's action state, so closing the dialog or reloading
 * the page loses it for good. It is never revalidated into the list below.
 */
export function InvitePortalUserForm({ clientId }: { clientId: string }) {
  return (
    <OneTimePasswordDialog triggerLabel="Invite user">
      {({ close }) => <InvitePortalUserBody clientId={clientId} onClose={close} />}
    </OneTimePasswordDialog>
  );
}

/**
 * Mounted by `OneTimePasswordDialog` and remounted on every close, which is
 * what resets `useActionState` — see that component. Do not lift this state up.
 */
function InvitePortalUserBody({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(invitePortalUserAction, null);
  const nameId = useId();
  const emailId = useId();
  const roleId = useId();

  return (
    <>
      <DialogHeader>
        <DialogTitle>{state?.ok ? "Portal account created" : "Invite a portal user"}</DialogTitle>
      </DialogHeader>

      {state?.ok ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{state.email}</span> can now sign in to the portal with this
            one-time password. It is shown once and cannot be retrieved again — send it to them now and ask them to
            change it under Account.
          </p>
          <p
            data-testid="one-time-password"
            className="rounded-md border bg-muted px-3 py-2 text-center font-mono text-base tracking-widest"
          >
            {state.oneTimePassword}
          </p>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <form action={action} className="space-y-3">
          <input type="hidden" name="clientId" value={clientId} />
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Full name</Label>
            <Input id={nameId} name="name" required maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={emailId}>Email address</Label>
            <Input id={emailId} name="email" type="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={roleId}>Role</Label>
            <NativeSelect id={roleId} name="role" defaultValue="client_member">
              <option value="client_member">Member</option>
              <option value="client_admin">Admin</option>
            </NativeSelect>
          </div>

          {state?.ok === false ? <InlineAlert tone="danger">{state.error}</InlineAlert> : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create portal user
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  );
}
