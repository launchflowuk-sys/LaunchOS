"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type PortalTab = { label: string; href: string };

/**
 * The portal's whole navigation: nine short labels on one line.
 *
 * It scrolls sideways rather than wrapping — DESIGN.md forbids a nav that
 * stacks into three rows, and on a 375px phone nine labels would do exactly
 * that. `w-max` on the row is what keeps it a single line inside the scroller.
 */
export function PortalTabs({ tabs }: { tabs: readonly PortalTab[] }) {
  const pathname = usePathname();
  // Longest match wins, so /portal/support/123 lights "Support" and not the
  // "/portal" overview as well.
  const current = tabs.reduce((best, tab) => {
    const matches = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    return matches && tab.href.length > best.length ? tab.href : best;
  }, "");

  return (
    <nav aria-label="Portal" className="scrollbar-none overflow-x-auto">
      <div className="mx-auto flex w-max max-w-5xl gap-1 px-4 pb-2.5 sm:px-6">
        {tabs.map((tab) => {
          const isCurrent = current === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isCurrent ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
                isCurrent
                  ? "bg-primary-soft font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
