"use client";

import { useState } from "react";
// The same constant Better Auth is configured with server-side
// (`minPasswordLength` in `lib/auth.ts`), imported rather than repeated so the
// two cannot drift. The `/passwords` subpath is dependency-free, so pulling it
// into a client component does not drag `@launchos/db`'s Postgres client into
// the browser bundle. The server is still what enforces the floor: this check
// and the `minLength` attribute below are both bypassable.
import { MIN_PASSWORD_LENGTH } from "@launchos/db/passwords";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDone(false);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setPending(true);
    // `revokeOtherSessions` is the point of a password change: if the old one
    // leaked, every session it opened has to go with it.
    const { error: changeError } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);

    if (changeError) {
      setError(changeError.message ?? "That password could not be changed.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setDone(true);
  }

  return (
    <form onSubmit={onSubmit} aria-label="Change password" className="max-w-sm space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          // Password managers rewrite these fields before React hydrates; that
          // is expected, not a bug.
          suppressHydrationWarning
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="h-11 bg-card"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          suppressHydrationWarning
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="h-11 bg-card"
        />
        <p className="text-meta text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      {done ? (
        <InlineAlert tone="success">Password changed. Any other devices have been signed out.</InlineAlert>
      ) : null}

      {/* `loading` keeps the label: the button's accessible name must not
          become "Saving…" for the length of the request. */}
      <Button type="submit" size="lg" loading={pending} className="w-full sm:w-auto">
        Change password
      </Button>
    </form>
  );
}
