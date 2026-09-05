"use client";

import { useActionState, useRef, type ReactNode } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
 * inline as an `InlineAlert`, the same box the rest of the product uses for a
 * send that failed. The action itself is a server action passed down as a prop,
 * which keeps `@launchos/db` and `@launchos/core` out of the browser bundle.
 *
 * The submit button is full width under `sm`: one clear primary action per
 * portal screen, sized for a thumb.
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
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => {
      const result = await action(formData);
      // The inputs are uncontrolled, so without this a successful submit leaves
      // what was just sent sitting in the box underneath the copy of it now in
      // the thread — and a second click posts it again.
      if (result.status === "ok") form.current?.reset();
      return result;
    },
    null,
  );

  return (
    <form ref={form} action={formAction} className={cn("min-w-0", className)} aria-label={ariaLabel}>
      {children}

      {state?.status === "error" ? (
        <InlineAlert tone="danger" className="mt-4">
          {state.message}
        </InlineAlert>
      ) : null}

      {state?.status === "ok" && success ? (
        <InlineAlert tone="success" className="mt-4">
          {success}
        </InlineAlert>
      ) : null}

      <div className="mt-4">
        {/* `loading` keeps the label in place — a button that swaps its words
            mid-submit moves the target under the thumb. */}
        <Button type="submit" size="lg" loading={pending} className="w-full sm:w-auto">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
