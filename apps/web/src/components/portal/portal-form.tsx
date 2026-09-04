"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The shape every portal server action returns: a failure is a sentence on the
 * form, never Next's error page. Declared structurally rather than imported so
 * this component stays independent of any one module's `schemas.ts`, exactly
 * as `ActionForm` does on the admin side.
 */
type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * A `<form>` whose server action returns an `ActionResult` instead of throwing.
 *
 * The portal has no toaster — a client should read what went wrong next to the
 * field they filled in, not in a corner that fades — so the result is rendered
 * inline. The action itself is a server action passed down as a prop, which
 * keeps `@launchos/db` and `@launchos/core` out of the browser bundle.
 */
export function PortalForm({
  action,
  children,
  submitLabel,
  className,
  ariaLabel,
  success,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  className?: string | undefined;
  ariaLabel?: string | undefined;
  success?: string | undefined;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => action(formData),
    null,
  );

  return (
    <form action={formAction} className={className} aria-label={ariaLabel}>
      {children}

      {state?.status === "error" ? (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.message}
        </p>
      ) : null}

      {state?.status === "ok" && success ? (
        <p role="status" className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </p>
      ) : null}

      <div className="mt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
