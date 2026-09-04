"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/**
 * Better Auth enforces its own minimum on the server; this is the same number
 * so the client is told before the round trip rather than after it.
 */
const MIN_PASSWORD_LENGTH = 12;

const CONTROL =
  "h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none";

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
    <form onSubmit={onSubmit} aria-label="Change password" className="max-w-sm space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="current-password" className="block text-sm font-medium text-neutral-700">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          // Password managers rewrite these fields before React hydrates; that
          // is expected, not a bug.
          suppressHydrationWarning
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={CONTROL}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="new-password" className="block text-sm font-medium text-neutral-700">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          suppressHydrationWarning
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className={CONTROL}
        />
        <p className="text-xs text-neutral-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Password changed. Any other devices have been signed out.
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
