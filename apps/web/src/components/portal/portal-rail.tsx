"use client";

import {
  BarChart3, FileText, FolderClosed, Globe, Headphones, Home, Link2, ListChecks,
  MessageCircle, Receipt, ScrollText, Sparkles, Wallet, type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The client portal's rail.
 *
 * White, not the admin's navy. A client is a guest here: the surface should
 * read as their workspace rather than as the inside of somebody's tooling, and
 * the one saturated thing on the page is the item they are on.
 *
 * Grouped rather than a flat list of eleven, because the groups answer
 * different questions — what you have, what we are doing, what it costs, where
 * to get help — and a client scans for the question before the screen.
 */
type Item = { label: string; href: string; icon: LucideIcon };
type Group = { label: string | null; items: readonly Item[] };

const NOOP = () => {};

export const PORTAL_NAV: readonly Group[] = [
  { label: null, items: [{ label: "Overview", href: "/portal", icon: Home }] },
  {
    label: "Your websites",
    items: [
      { label: "Websites", href: "/portal/sites", icon: Globe },
      { label: "Domains", href: "/portal/domains", icon: Link2 },
    ],
  },
  {
    label: "Your projects",
    items: [
      { label: "Progress", href: "/portal/tasks", icon: ListChecks },
      { label: "Content", href: "/portal/content", icon: FileText },
      { label: "Documents", href: "/portal/documents", icon: FolderClosed },
    ],
  },
  {
    label: "Billing",
    items: [
      { label: "Proposals", href: "/portal/proposals", icon: ScrollText },
      { label: "Invoices", href: "/portal/invoices", icon: Receipt },
      { label: "Plan", href: "/portal/plan", icon: Wallet },
      { label: "Add a service", href: "/portal/services", icon: Sparkles },
    ],
  },
  {
    label: "Help & insights",
    items: [
      { label: "Support", href: "/portal/support", icon: Headphones },
      { label: "Reports", href: "/portal/reports", icon: BarChart3 },
    ],
  },
];

/** Longest match wins, so `/portal/invoices/3` lights Invoices, not Overview. */
function activeHref(pathname: string): string {
  let best = "";
  for (const group of PORTAL_NAV) {
    for (const item of group.items) {
      const hit = item.href === "/portal"
        ? pathname === "/portal"
        : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (hit && item.href.length > best.length) best = item.href;
    }
  }
  return best;
}

export function PortalNavList({ onNavigate = NOOP }: { onNavigate?: (() => void) | undefined }) {
  const current = activeHref(usePathname());

  return (
    <nav aria-label="Portal" className="flex-1 space-y-6 overflow-y-auto px-4 py-5">
      {PORTAL_NAV.map((group, index) => (
        <div key={group.label ?? `group-${index}`}>
          {group.label ? (
            <p className="label-caps px-3 pb-2 text-muted-foreground">{group.label}</p>
          ) : null}
          <div className="space-y-1">
            {group.items.map((item) => {
              const Icon = item.icon;
              const isCurrent = current === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isCurrent ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-base transition-colors",
                    isCurrent
                      ? "bg-primary font-semibold text-primary-foreground"
                      : "text-foreground hover:bg-primary-soft/70",
                  )}
                >
                  <Icon
                    aria-hidden
                    strokeWidth={1.75}
                    className={cn("size-5 shrink-0", isCurrent ? "text-primary-foreground" : "text-muted-foreground")}
                  />
                  <span className="truncate">{item.label}</span>
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
 * The way out of the portal and into a person.
 *
 * Sits at the bottom of the rail rather than in the nav: it is not a screen,
 * it is the answer to "I am stuck", and it should be reachable from every one
 * of them without being mistaken for one.
 */
export function PortalHelpCard({ onNavigate = NOOP }: { onNavigate?: (() => void) | undefined }) {
  return (
    <div className="px-4 pb-5">
      <Link
        href="/portal/support/new"
        onClick={onNavigate}
        className="flex items-center gap-3 rounded-[16px] bg-primary-soft p-4 transition-colors hover:bg-primary-soft/70"
      >
        <MessageCircle aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Need a hand?</span>
          <span className="block text-meta text-primary">Talk to LaunchFlow</span>
        </span>
        <span aria-hidden className="text-primary">→</span>
      </Link>
    </div>
  );
}
