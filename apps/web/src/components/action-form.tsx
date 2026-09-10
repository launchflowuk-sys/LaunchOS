"use client";

import { type ReactNode, useRef } from "react";
import { toast } from "sonner";
import { showSaved } from "./saved-overlay";

/**
 * The shape every admin server action returns: a failure is a message, never
 * Next's error page. Declared structurally rather than imported so this
 * component stays independent of any one module's `schemas.ts`.
 */
type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * A `<form>` whose server action returns an `ActionResult` instead of throwing.
 *
 * A server component cannot show a toast, so the forms on the task detail,
 * client Tasks tab and settings screens post through this one client wrapper.
 * The action itself is a server action passed down as a prop — no `@launchos/db`
 * or `@launchos/core` import reaches the browser bundle.
 */
export function ActionForm({
  action,
  children,
  className,
  ariaLabel,
  success,
  resetOnSuccess = false,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  success?: string;
  resetOnSuccess?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={form}
      className={className}
      aria-label={ariaLabel}
      action={async (formData) => {
        // The actions revalidate their own paths, so a successful submit is
        // re-rendered by the server without a client-side refresh.
        const result = await action(formData);
        if (result.status === "error") return void toast.error(result.message);
        // The card, not a corner toast. A failure keeps the toast: it carries
        // the provider's own words and needs reading time, which a card that
        // leaves on its own does not give.
        if (success) showSaved(success);
        if (resetOnSuccess) form.current?.reset();
      }}
    >
      {children}
    </form>
  );
}
