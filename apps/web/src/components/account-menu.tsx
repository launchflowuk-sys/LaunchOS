"use client";

import { ChevronDown, CircleUser, LogOut } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { initialsFromEmail } from "@/components/app-nav";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

/**
 * The account corner of the admin top bar: who is signed in, the way to
 * `/account`, and the way out.
 *
 * Sign-out mirrors the portal's button — a failed call must still not strand
 * somebody inside the shell, so the push and the refresh happen either way and
 * the gate re-checks the cookie on the next request.
 */
export function AccountMenu({ email, role }: { email: string; role: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await authClient.signOut();
    } finally {
      router.push("/sign-in");
      router.refresh();
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${email}`}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-1.5 text-sm transition-colors hover:bg-muted"
      >
        <Avatar className="size-6">
          <AvatarFallback className="bg-primary-soft text-[0.625rem] font-semibold text-primary">
            {initialsFromEmail(email)}
          </AvatarFallback>
        </Avatar>
        <ChevronDown aria-hidden strokeWidth={1.75} className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="min-w-0">
          <span className="block truncate text-row font-medium">{email}</span>
          <span className="block text-meta font-normal capitalize text-muted-foreground">{role}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <CircleUser aria-hidden strokeWidth={1.75} />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={pending}
          onSelect={(event) => {
            event.preventDefault();
            void signOut();
          }}
        >
          <LogOut aria-hidden strokeWidth={1.75} />
          {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
