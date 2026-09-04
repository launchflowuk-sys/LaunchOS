"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { NavGroup } from "@/lib/nav";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

const NOOP = () => {};

function NavList({ groups, onNavigate = NOOP }: { groups: readonly NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto p-3">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{group.label}</p>
          <div className="space-y-0.5">
            {/* Every entry is a link: the disabled "arrives in Plan N" label
                went out with the last pending module (see `lib/nav.ts`). */}
            {group.items.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
                className={cn(
                  "block rounded-md px-3 py-2 text-sm transition-colors",
                  isActive(pathname, item.href)
                    ? "bg-neutral-100 font-medium text-neutral-900"
                    : "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/**
 * The signed-in staff member's own corner of the shell. "Account" is the only
 * way to `/account`, which is deliberately not a nav module: it is where a
 * member replaces the one-time password an owner issued them with one of their
 * own, so it has to be reachable from every admin screen.
 */
function Identity({ email, role, onNavigate = NOOP }: { email: string; role: string; onNavigate?: () => void }) {
  return (
    <div className="border-t border-neutral-200 px-5 py-4 text-xs text-neutral-500">
      <p className="truncate font-medium text-neutral-700">{email}</p>
      <p className="mt-0.5 capitalize">{role}</p>
      <Link href="/account" onClick={onNavigate} className="mt-1.5 inline-block text-neutral-600 hover:text-neutral-900 hover:underline">
        Account
      </Link>
    </div>
  );
}

export function AppNav({ groups, email, role }: { groups: readonly NavGroup[]; email: string; role: string }) {
  const pathname = usePathname();
  // The drawer remembers the route it was opened on, so any navigation closes
  // it without an effect: a tap-through never leaves the overlay covering the
  // page it just opened.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);

  return (
    <>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-neutral-200 bg-white lg:flex">
        <div className="border-b border-neutral-200 px-5 py-4">
          <p className="text-sm font-semibold tracking-tight text-neutral-900">LaunchOS</p>
          <p className="mt-0.5 text-xs text-neutral-500">Admin portal</p>
        </div>
        <NavList groups={groups} />
        <Identity email={email} role={role} />
      </aside>

      {/* Under 1024px the sidebar collapses into a sheet (spec §2). Radix keeps
          the panel out of the DOM while it is closed, so the desktop aside stays
          the only navigation landmark on the page. */}
      <Sheet open={open} onOpenChange={setOpen}>
        {/* self-start keeps the trigger a button rather than a full-height
            column: it is a flex child of the shell row, which stretches by
            default. The margin lines it up with the header beside it. */}
        <SheetTrigger
          aria-label="Open menu"
          className="m-3 self-start rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-700 lg:hidden"
        >
          Menu
        </SheetTrigger>
        <SheetContent side="left" className="w-72 gap-0 bg-white p-0 sm:max-w-72">
          <SheetHeader className="border-b border-neutral-200 px-5 py-4">
            <SheetTitle className="text-sm font-semibold tracking-tight text-neutral-900">LaunchOS</SheetTitle>
            <SheetDescription className="text-xs text-neutral-500">Admin portal</SheetDescription>
          </SheetHeader>
          <NavList groups={groups} onNavigate={() => setOpen(false)} />
          <Identity email={email} role={role} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
