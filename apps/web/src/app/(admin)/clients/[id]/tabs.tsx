import Link from "next/link";
import { TabScroller } from "@/components/tab-scroller";
import { cn } from "@/lib/utils";

/** Sections the client detail page renders itself, chosen with `?tab=`. */
export type ClientTabKey = "overview" | "contacts" | "sites";

/**
 * Access, Tasks, Support, Portal users, Invoices and Reports are routes of their own
 * rather than `?tab=` sections: each owns its own queries, forms and server
 * actions, which would push the detail page well past the file-size rule.
 */
export type ClientTabRoute =
  | "services" | "access" | "tasks" | "content" | "support" | "portal-users" | "invoices" | "payments" | "profit" | "reports";
export type ClientTabActive = ClientTabKey | ClientTabRoute;

const ROUTES: readonly ClientTabRoute[] = [
  "services", "access", "tasks", "content", "support", "portal-users", "invoices", "payments", "profit", "reports",
];

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "contacts", label: "Contacts & Billing" },
  { key: "sites", label: "Sites & Domains" },
  { key: "services", label: "Services" },
  { key: "access", label: "Access" },
  { key: "tasks", label: "Tasks" },
  { key: "content", label: "Content" },
  { key: "support", label: "Support" },
  { key: "portal-users", label: "Portal users" },
  { key: "invoices", label: "Invoices" },
  { key: "payments", label: "Payments" },
  { key: "profit", label: "Profit" },
  { key: "reports", label: "Reports" },
] as const satisfies readonly { key: ClientTabActive; label: string }[];

/** The `?tab=` keys the detail page accepts — every tab that is not its own route. */
export const CLIENT_TABS = TABS.filter((tab) => !ROUTES.includes(tab.key as ClientTabRoute));

function hrefFor(clientId: string, key: ClientTabActive): string {
  return ROUTES.includes(key as ClientTabRoute)
    ? `/clients/${clientId}/${key}`
    : `/clients/${clientId}?tab=${key}`;
}

/**
 * Links rather than a Radix `Tabs` list: each tab is a real navigation with its
 * own URL, and most of them are routes of their own. Thirteen labels never fit
 * one phone width — and do not fit a laptop either — so the row scrolls
 * sideways inside itself instead of wrapping to three lines.
 *
 * `TabScroller` is what makes that scroll *visible*. Without it the row was
 * still scrollable and looked broken: the scrollbar is hidden by design, so
 * "Reports" was sliced down the middle of its first letter with nothing to
 * suggest there was anything past it, and from the Profit tab there was no way
 * to reach Reports at all. It also scrolls the current tab into view, so
 * landing on a late tab does not leave it off-screen.
 */
export function ClientTabs({ clientId, active }: { clientId: string; active: ClientTabActive }) {
  return (
    <div className="mb-6 border-b">
      <TabScroller className="-mb-px gap-1">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={hrefFor(clientId, tab.key)}
            aria-current={tab.key === active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              tab.key === active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </TabScroller>
    </div>
  );
}
