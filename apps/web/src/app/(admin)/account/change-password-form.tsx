"use client";

import { useActionState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeOwnPasswordAction, type ChangePasswordState } from "./actions";

/**
 * The same number Better Auth is configured with server-side
 * (`minPasswordLength` in `lib/auth.ts`), repeated here only so the browser
 * says so before the round trip rather than after it. The server is what
 * enforces it: this attribute is bypassable and the action does not trust it.
 */
const MIN_PASSWORD_LENGTH = 12;

const INITIAL: ChangePasswordState = { status: "idle" };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changeOwnPasswordAction, INITIAL);

  return (
    <form action={formAction} aria-label="Change password" className="max-w-sm space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="currentPassword">Current password</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          // Password managers rewrite these fields before React hydrates; that
          // is expected, not a bug.
          suppressHydrationWarning
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          suppressHydrationWarning
        />
        <p className="text-meta text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>

      {state.status === "error" ? (
        <div data-testid="password-error">
          <InlineAlert tone="danger">{state.message}</InlineAlert>
        </div>
      ) : null}

      {/*
        One element for both outcomes, because both mean the same thing about
        the credential: it has been replaced. The warning only qualifies what
        happened to the member's *other* sessions afterwards, so it must never
        read as a failure — the new password is the live one either way.
      */}
      {state.status === "changed" ? (
        <div role="status" data-testid="password-changed">
          <InlineAlert tone={state.warning ? "warning" : "success"}>
            {state.warning ?? "Password changed. Any other devices have been signed out."}
          </InlineAlert>
        </div>
      ) : null}

      <Button type="submit" loading={pending}>
        Change password
      </Button>
    </form>
  );
}
