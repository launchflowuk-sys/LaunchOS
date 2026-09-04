"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { invitePortalUserAction, type InviteState } from "./actions";

const CONTROL =
  "h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none";

/**
 * Same shape as the Team screen's one-time-password dialog: the password lives
 * only in this component's action state, so closing the dialog or reloading the
 * page loses it for good. It is never revalidated into the list below.
 */
export function InvitePortalUserForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<InviteState, FormData>(invitePortalUserAction, null);

  function close() {
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button>Invite user</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state?.ok ? "Portal account created" : "Invite a portal user"}</DialogTitle>
        </DialogHeader>

        {state?.ok ? (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              <span className="font-medium text-neutral-900">{state.email}</span> can now sign in to the portal with
              this one-time password. It is shown once and cannot be retrieved again — send it to them now and ask them
              to change it under Account.
            </p>
            <p
              data-testid="one-time-password"
              className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-center font-mono text-base tracking-widest text-neutral-900"
            >
              {state.oneTimePassword}
            </p>
            <div className="flex justify-end">
              <Button type="button" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form action={action} className="space-y-3">
            <input type="hidden" name="clientId" value={clientId} />
            <div className="space-y-1.5">
              <label htmlFor="portal-user-name" className="block text-sm font-medium text-neutral-700">
                Full name
              </label>
              <input id="portal-user-name" name="name" required maxLength={120} className={CONTROL} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="portal-user-email" className="block text-sm font-medium text-neutral-700">
                Email address
              </label>
              <input id="portal-user-email" name="email" type="email" required className={CONTROL} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="portal-user-role" className="block text-sm font-medium text-neutral-700">
                Role
              </label>
              <select id="portal-user-role" name="role" defaultValue="client_member" className={CONTROL}>
                <option value="client_member">Member</option>
                <option value="client_admin">Admin</option>
              </select>
            </div>

            {state?.ok === false ? (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {state.error}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create portal user"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
