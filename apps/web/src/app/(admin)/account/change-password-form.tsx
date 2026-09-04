"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { changeOwnPasswordAction, type ChangePasswordState } from "./actions";

/**
 * The same number Better Auth is configured with server-side
 * (`minPasswordLength` in `lib/auth.ts`), repeated here only so the browser
 * says so before the round trip rather than after it. The server is what
 * enforces it: this attribute is bypassable and the action does not trust it.
 */
const MIN_PASSWORD_LENGTH = 12;

const INITIAL: ChangePasswordState = { status: "idle" };

const CONTROL =
  "h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none";

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changeOwnPasswordAction, INITIAL);

  return (
    <form action={formAction} aria-label="Change password" className="max-w-sm space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="currentPassword" className="block text-sm font-medium text-neutral-700">
          Current password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          // Password managers rewrite these fields before React hydrates; that
          // is expected, not a bug.
          suppressHydrationWarning
          className={CONTROL}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="newPassword" className="block text-sm font-medium text-neutral-700">
          New password
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          suppressHydrationWarning
          className={CONTROL}
        />
        <p className="text-xs text-neutral-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>

      {state.status === "error" ? (
        <p role="alert" data-testid="password-error" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.message}
        </p>
      ) : null}

      {/*
        One element for both outcomes, because both mean the same thing about
        the credential: it has been replaced. The warning only qualifies what
        happened to the member's *other* sessions afterwards, so it must never
        read as a failure — the new password is the live one either way.
      */}
      {state.status === "changed" ? (
        <p
          role="status"
          data-testid="password-changed"
          className={
            state.warning
              ? "rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800"
              : "rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
          }
        >
          {state.warning ?? "Password changed. Any other devices have been signed out."}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
