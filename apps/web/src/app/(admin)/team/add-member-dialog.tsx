"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { addMemberAction, type AddMemberState } from "./actions";

const INITIAL: AddMemberState = { status: "idle" };

export function AddMemberDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(addMemberAction, INITIAL);

  function close() {
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button>Add member</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state.status === "created" ? "Member added" : "Add team member"}</DialogTitle>
        </DialogHeader>

        {state.status === "created" ? (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              {state.displayName} can sign in with <span className="font-medium text-neutral-900">{state.email}</span> and this
              one-time password. It is shown once and cannot be retrieved again — send it to them now and ask them to change it.
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
          <form action={formAction} className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="displayName" className="block text-sm font-medium text-neutral-700">
                Full name
              </label>
              <input
                id="displayName"
                name="displayName"
                required
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-sm font-medium text-neutral-700">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="title" className="block text-sm font-medium text-neutral-700">
                Job title
              </label>
              <input
                id="title"
                name="title"
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="role" className="block text-sm font-medium text-neutral-700">
                Role
              </label>
              <select
                id="role"
                name="role"
                defaultValue="staff"
                className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              >
                <option value="staff">Staff</option>
                <option value="owner">Owner</option>
              </select>
            </div>

            {state.status === "error" ? (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {state.message}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create member"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
