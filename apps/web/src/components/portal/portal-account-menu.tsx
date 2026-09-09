"use client";

import { Building2, ChevronUp, CreditCard, LogOut, Shield, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/** "Hardi Saleh" → "HS"; falls back to the email when there is no name. */
export function initials(name: string, email: string): string {
  const fromName = name.trim().split(/\s+/).filter(Boolean);
  if (fromName.length >= 2) return `${fromName[0]![0]}${fromName[1]![0]}`.toUpperCase();
  if (fromName.length === 1 && fromName[0]!.length > 1) return fromName[0]!.slice(0, 2).toUpperCase();
  return (email.split("@")[0] ?? "?").slice(0, 2).toUpperCase();
}

/**
 * The client's own corner.
 *
 * Everything about *them* rather than about their work lives here — details,
 * company, billing, security, and the way out. It is deliberately not in the
 * rail: the rail is the work, and mixing "your password" into a list of
 * websites and invoices is how a nav stops being scannable.
 */
export function PortalAccountMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const items = [
    { label: "Personal details", href: "/portal/account", icon: User },
    { label: "Company details", href: "/portal/account#company", icon: Building2 },
    { label: "Billing & plan", href: "/portal/plan", icon: CreditCard },
    { label: "Security", href: "/portal/account#security", icon: Shield },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-12 items-center gap-2.5 rounded-[14px] border bg-card pl-1.5 pr-3 transition-colors hover:bg-primary-soft/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Account: ${email}`}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-meta font-semibold text-primary-foreground">
          {initials(name, email)}
        </span>
        <span className="hidden min-w-0 text-left sm:block">
          <span className="block truncate text-row font-semibold leading-tight">{name || email}</span>
          <span className="block text-meta leading-tight text-muted-foreground">My account</span>
        </span>
        <ChevronUp aria-hidden strokeWidth={1.75} className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72 rounded-[16px] p-0">
        <div className="flex items-center gap-3 border-b px-4 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-row font-semibold text-primary-foreground">
            {initials(name, email)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold">{name || "Your account"}</span>
            <span className="block truncate text-meta text-muted-foreground">{email}</span>
          </span>
        </div>

        <div className="p-2">
          {items.map((item) => (
            <DropdownMenuItem key={item.label} asChild className="rounded-[10px] px-3 py-2.5 text-row">
              <Link href={item.href}>
                <item.icon aria-hidden strokeWidth={1.75} className="size-4 text-muted-foreground" />
                {item.label}
              </Link>
            </DropdownMenuItem>
          ))}
        </div>

        <DropdownMenuSeparator className="my-0" />

        <div className="p-2">
          <DropdownMenuItem
            className={cn("rounded-[10px] px-3 py-2.5 text-row font-medium text-danger-fg focus:text-danger-fg")}
            disabled={signingOut}
            onSelect={(event) => {
              // The menu would close and unmount the row mid-request otherwise,
              // and the "Signing out…" label would never be seen.
              event.preventDefault();
              setSigningOut(true);
              void authClient.signOut().then(() => {
                router.push("/sign-in");
                router.refresh();
              });
            }}
          >
            <LogOut aria-hidden strokeWidth={1.75} className="size-4" />
            {signingOut ? "Signing out…" : "Sign out"}
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
