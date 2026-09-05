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
export function SignOutButton({
  variant = "secondary",
  size = "md",
}: {
  variant?: "secondary" | "ghost";
  size?: "sm" | "md";
}) {
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

  // `loading` rather than a swapped label: the word "Sign out" is the button's
  // accessible name, and it should not become "Signing out…" for the half
  // second the request takes.
  return (
    <Button type="button" variant={variant} size={size} onClick={signOut} loading={pending}>
      Sign out
    </Button>
  );
}
