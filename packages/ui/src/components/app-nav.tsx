"use client";

import type { LucideIcon } from "lucide-react";
import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Avatar, AvatarFallback } from "./ui/avatar.js";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "./ui/sheet.js";
import { type Category, CATEGORY_DOT } from "../lib/categories.js";
import { cn } from "../lib/utils.js";

/**
 * One entry on the rail. `icon` is a component, which is why a consumer binds
 * its own menu inside a client component rather than passing groups down from
 * a server one — a component reference cannot cross the RSC boundary.
 */
export type NavItem = {
  label: string;
  href: string;
  /** 16px on the rail at `stroke-width 1.75`, set by the nav rather than here. */
  icon: LucideIcon;
};

export type NavGroup = { label: string; category: Category; items: readonly NavItem[] };

export type AppNavProps = {
  /** Already filtered. The rail renders what it is given; it decides nothing. */
  groups: readonly NavGroup[];
  email: string;
  role: string;
  /** The wordmark, on whatever chip the consumer's brand needs. */
  brand: ReactNode;
  /** Under the wordmark. "Admin portal" in LaunchOS. */
  subtitle?: string;
  /** Counts by href, e.g. `{ "/approvals": 3 }`. Serializable on purpose. */
  badges?: Readonly<Record<string, number>>;
  /** Where the identity block's link goes. */
  accountHref?: string;
  /** The sheet's screen-reader title. */
  srTitle?: string;
};

const NOOP = () => {};

/**
 * The longest matching href wins, so `/ads/reports` lights "Ad reports" alone
 * rather than "Ads" as well. `/` only ever matches itself.
 */
function activeHref(pathname: string, groups: readonly NavGroup[]): string {
  let best = "";
  for (const group of groups) {
    for (const item of group.items) {
      const matches =
        item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (matches && item.href.length > best.length) best = item.href;
    }
  }
  return best;
}

/** "shujaat@nexusedu.co.uk" → "SH"; "ada.lovelace@…" → "AL". */
export function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (local.slice(0, 2) || "?").toUpperCase();
}

function NavList({
  groups,
  badges,
  onNavigate = NOOP,
}: {
  groups: readonly NavGroup[];
  badges?: Readonly<Record<string, number>> | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  const pathname = usePathname();
  const current = activeHref(pathname, groups);

  return (
    <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="label-caps flex items-center gap-2 px-3 pb-1.5 text-sidebar-muted">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", CATEGORY_DOT[group.category])} />
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const isCurrent = current === item.href;
              const badge = badges?.[item.href] ?? 0;
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isCurrent ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                    isCurrent
                      ? "bg-sidebar-active font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  {/* The logo's cyan is what says "you are here". The active
                      pill alone is only 1.38:1 against the rail; the marker is
                      8.48:1, so the current item is findable at a glance rather
                      than by comparing two dark blues. */}
                  {isCurrent ? (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-brand-cyan"
                    />
                  ) : null}
                  <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {badge > 0 ? (
                    <span
                      className="ml-auto shrink-0 rounded-full bg-warning-bg px-1.5 py-0.5 text-meta leading-none font-semibold tabular-nums text-warning-fg"
                      aria-label={`${badge} waiting for a decision`}
                    >
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/**
 * The signed-in member's own corner of the shell. The account link is here
 * rather than in the nav because it is where a member replaces the one-time
 * password an owner issued them, so it has to be reachable from every screen.
 */
function Identity({
  email,
  role,
  accountHref = "/account",
  onNavigate = NOOP,
}: {
  email: string;
  role: string;
  accountHref?: string | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <div className="border-t border-sidebar-border px-4 py-4">
      <div className="flex items-center gap-3">
        <Avatar className="size-8 shrink-0">
          <AvatarFallback className="bg-sidebar-active text-meta font-semibold text-sidebar-accent-foreground">
            {initialsFromEmail(email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-row font-medium text-sidebar-accent-foreground">{email}</p>
          <p className="text-meta capitalize text-sidebar-muted">{role}</p>
        </div>
      </div>
      <Link
        href={accountHref}
        onClick={onNavigate}
        className="mt-3 inline-block text-row text-sidebar-muted transition-colors hover:text-sidebar-accent-foreground"
      >
        Account
      </Link>
    </div>
  );
}

/** The 256px navy rail, `lg` and up. */
export function AppNav({
  groups, email, role, brand, subtitle, badges, accountHref,
}: AppNavProps) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
      <div className="border-b border-sidebar-border px-5 py-4">
        {brand}
        {subtitle ? <p className="mt-2 text-meta text-sidebar-muted">{subtitle}</p> : null}
      </div>
      <NavList groups={groups} badges={badges} />
      <Identity email={email} role={role} accountHref={accountHref} />
    </aside>
  );
}

/**
 * The same navigation as a sheet, opened from the menu icon in the top bar
 * under `lg`. Radix keeps the panel out of the DOM while it is closed, so the
 * desktop rail stays the only navigation landmark on a wide screen.
 */
export function AppNavSheet({
  groups, email, role, brand, subtitle, badges, accountHref, srTitle = "Menu",
}: AppNavProps) {
  const pathname = usePathname();
  // The drawer remembers the route it was opened on, so any navigation closes
  // it without an effect: a tap-through never leaves the overlay covering the
  // page it just opened.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open menu"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border text-foreground transition-colors hover:bg-muted lg:hidden"
      >
        <Menu aria-hidden strokeWidth={1.75} className="size-4" />
      </SheetTrigger>
      <SheetContent
        side="left"
        className="flex w-72 flex-col gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-72"
      >
        <SheetHeader className="border-b border-sidebar-border px-5 py-4">
          {/* Radix needs a title and a description on the dialog; the wordmark
              is the visible one, so the title stays for screen readers only. */}
          <SheetTitle className="sr-only">{srTitle}</SheetTitle>
          {brand}
          {subtitle ? <SheetDescription className="text-meta text-sidebar-muted">{subtitle}</SheetDescription> : null}
        </SheetHeader>
        <NavList groups={groups} badges={badges} onNavigate={() => setOpen(false)} />
        <Identity email={email} role={role} accountHref={accountHref} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
