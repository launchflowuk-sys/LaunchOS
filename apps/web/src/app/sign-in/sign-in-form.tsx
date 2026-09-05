"use client";

import { Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/**
 * The sign-in form. `notice` is resolved by the server component next door —
 * why a gate sent somebody back here, e.g. portal access that has been removed
 * — so this file needs no search-param hook and no Suspense boundary.
 *
 * One card on the cool workspace ground, centred, `max-w-sm` so it never
 * stretches on a desktop and never crowds a 375px phone. The two audiences it
 * serves — Shoji on his phone and a client signing in twice a year — both get
 * 16px fields at 44px tall, which is also what stops iOS zooming the page on
 * focus.
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
    <main className="flex min-h-screen flex-1 items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-xl bg-sidebar text-sidebar-accent-foreground"
          >
            <Rocket strokeWidth={1.75} className="size-5" />
          </span>
          <h1 className="mt-3 text-title font-semibold">LaunchOS</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to your account.
          </p>
        </div>

        {notice ? (
          <InlineAlert tone="warning" className="mb-4">
            {notice}
          </InlineAlert>
        ) : null}

        <form onSubmit={onSubmit} aria-label="Sign in" className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                // Mobile browsers and password managers add attributes to these fields
                // before React hydrates; that is expected, not a bug.
                suppressHydrationWarning
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 bg-card"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                suppressHydrationWarning
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 bg-card"
              />
            </div>
          </div>

          {error ? (
            <InlineAlert tone="danger" title="Could not sign in" className="mt-4">
              {error}
            </InlineAlert>
          ) : null}

          {/* `loading` keeps the label: the accessible name of the one action on
              this page must not change to "Signing in…" mid-request. */}
          <Button type="submit" size="lg" loading={pending} className="mt-5 w-full">
            Sign in
          </Button>

          <p className="mt-4 text-center text-meta text-muted-foreground">
            Forgotten your password? Ask us and we will send you a new one.
          </p>
        </form>

        <p className="mt-6 text-center text-meta text-muted-foreground">Powered by LaunchFlow</p>
      </div>
    </main>
  );
}
