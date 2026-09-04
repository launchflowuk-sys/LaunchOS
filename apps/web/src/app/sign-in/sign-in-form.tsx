"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/**
 * The sign-in form. `notice` is resolved by the server component next door —
 * why a gate sent somebody back here, e.g. portal access that has been removed
 * — so this file needs no search-param hook and no Suspense boundary.
 */
export function SignInForm({ notice }: { notice: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const { error: signInError } = await authClient.signIn.email({ email, password });

    if (signInError) {
      setError(signInError.message ?? "Could not sign in with those details.");
      setPending(false);
      return;
    }

    router.push("/after-sign-in");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">LaunchOS</h1>
          <p className="mt-1 text-sm text-neutral-500">Sign in to LaunchOS.</p>
        </div>

        {notice ? (
          <p role="status" className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {notice}
          </p>
        ) : null}

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm"
        >
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-neutral-700">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              // Mobile browsers and password managers add attributes to these fields
              // before React hydrates; that is expected, not a bug.
              suppressHydrationWarning
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium text-neutral-700">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              // Mobile browsers and password managers add attributes to these fields
              // before React hydrates; that is expected, not a bug.
              suppressHydrationWarning
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-neutral-400">Powered by LaunchFlow</p>
      </div>
    </main>
  );
}
