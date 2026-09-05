"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/**
 * Ends the portal session.
 *
 * A client may well be on a shared or public machine; without this the only
 * way out is clearing cookies. `router.refresh()` after the push throws away
 * the cached server render of the portal shell, so the back button lands on
 * the sign-in gate rather than on a stale page.
 */
export function SignOutButton({ variant = "secondary" }: { variant?: "secondary" | "ghost" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await authClient.signOut();
    } finally {
      // Even a failed sign-out call should not strand somebody inside the
      // portal: the gate re-checks the cookie on the next request either way.
      router.push("/sign-in");
      router.refresh();
    }
  }

  return (
    <Button type="button" variant={variant} onClick={signOut} disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
