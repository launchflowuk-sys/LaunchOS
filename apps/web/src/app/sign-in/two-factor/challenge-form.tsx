"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BrandTile } from "@/components/brand-mark";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

type Method = "totp" | "backup";

const COPY: Record<Method, { label: string; hint: string; switchTo: string }> = {
  totp: {
    label: "Code from your authenticator app",
    hint: "Six digits, from the app you set up on your phone.",
    switchTo: "Use a backup code instead",
  },
  backup: {
    label: "Backup code",
    hint: "One of the single-use codes you saved when you set two-factor up. It works once, then it is spent.",
    switchTo: "Use my authenticator app instead",
  },
};

/**
 * The second half of signing in.
 *
 * The password has already been accepted; Better Auth deleted the session it
 * would have created and left a short-lived, signed challenge cookie in its
 * place, which is the only thing authorising this page. Nothing here knows or
 * says who is signing in — the page is reachable by anyone holding that cookie
 * and naming the account would tell them something they have not earned.
 *
 * Same card, same width, same 44px fields as `/sign-in`: this is one flow in
 * two steps, and it should not feel like a different product.
 */
export function TwoFactorChallengeForm() {
  const router = useRouter();
  const [method, setMethod] = useState<Method>("totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const trimmed = code.trim();
    const { error: failed } =
      method === "totp"
        ? await authClient.twoFactor.verifyTotp({ code: trimmed })
        : await authClient.twoFactor.verifyBackupCode({ code: trimmed });

    if (failed) {
      setError(failed.message ?? "That code was not accepted.");
      setPending(false);
      setCode("");
      return;
    }

    router.push("/after-sign-in");
    router.refresh();
  }

  const copy = COPY[method];

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <h1 className="flex justify-center">
            <BrandTile width={148} className="rounded-xl border px-5 py-3.5 shadow-sm" priority />
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">One more step — your second factor.</p>
        </div>

        <form onSubmit={onSubmit} aria-label="Two-factor code" className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="space-y-1.5">
            <Label htmlFor="code">{copy.label}</Label>
            <Input
              id="code"
              name="code"
              // `one-time-code` is what lets iOS and Android offer the code
              // from the notification; it is right for a backup code too.
              autoComplete="one-time-code"
              inputMode={method === "totp" ? "numeric" : "text"}
              autoFocus
              required
              suppressHydrationWarning
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="h-11 bg-card font-mono text-base tracking-[0.25em]"
            />
            <p className="text-meta text-muted-foreground">{copy.hint}</p>
          </div>

          {error ? (
            <InlineAlert tone="danger" title="Could not sign in" className="mt-4">
              {error}
            </InlineAlert>
          ) : null}

          <Button type="submit" size="lg" loading={pending} className="mt-5 w-full">
            Sign in
          </Button>

          <div className="mt-4 text-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setMethod(method === "totp" ? "backup" : "totp");
                setCode("");
                setError(null);
              }}
            >
              {copy.switchTo}
            </Button>
          </div>
        </form>

        <p className="mt-4 text-center text-meta text-muted-foreground">
          Lost your phone and your backup codes? Ask us and we will take the second factor off your account.
        </p>
        <p className="mt-6 text-center text-meta text-muted-foreground">Powered by LaunchFlow</p>
      </div>
    </main>
  );
}
