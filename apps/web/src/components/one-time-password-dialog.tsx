"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

/**
 * Shell for the three flows that mint a login and show its one-time password
 * exactly once: Team → Add member, Team → Re-issue password, and Client →
 * Portal users → Invite user.
 *
 * The body is supplied as a render prop and remounted on every close via
 * `key={round}`, so the `useActionState` that lives inside it starts fresh each
 * time the dialog is opened. Without that reset the previous result survives —
 * `router.refresh()` is a soft refresh and preserves client component state —
 * and reopening the dialog would show the *last* user's password with no form,
 * making a second invite impossible without a full page reload.
 *
 * Keep `useActionState` (and anything else holding the password) inside the
 * render prop, never in the caller: state above this component is not reset.
 */
export function OneTimePasswordDialog({
  triggerLabel,
  trigger,
  children,
}: {
  /** Label for the default primary-button trigger; also the accessible name. */
  triggerLabel: string;
  /**
   * Replaces the default `<Button>` when the caller needs a different control —
   * the per-row "Re-issue password" is a plain text button inside a table cell,
   * not a primary action. Must be a single element that accepts a ref and the
   * props Radix spreads onto it (`asChild`).
   */
  trigger?: ReactNode;
  children: (props: { close: () => void }) => ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);

  function close() {
    setOpen(false);
    setRound((current) => current + 1);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>{trigger ?? <Button>{triggerLabel}</Button>}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <Fragment key={round}>{children({ close })}</Fragment>
      </DialogContent>
    </Dialog>
  );
}
