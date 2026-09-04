import Link from "next/link";
import { cn } from "@/lib/utils";

/** Sections the client detail page renders itself, chosen with `?tab=`. */
export type ClientTabKey = "overview" | "contacts" | "sites";

/**
 * Tasks, Support, Portal users, Invoices and Reports are routes of their own
 * rather than `?tab=` sections: each owns its own queries, forms and server
 * actions, which would push the detail page well past the file-size rule.
 */
export type ClientTabRoute = "tasks" | "support" | "portal-users" | "invoices" | "reports";
export type ClientTabActive = ClientTabKey | ClientTabRoute;

const ROUTES: readonly ClientTabRoute[] = ["tasks", "support", "portal-users", "invoices", "reports"];

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "contacts", label: "Contacts & Billing" },
  { key: "sites", label: "Sites & Domains" },
  { key: "tasks", label: "Tasks" },
  { key: "support", label: "Support" },
  { key: "portal-users", label: "Portal users" },
  { key: "invoices", label: "Invoices" },
  { key: "reports", label: "Reports" },
] as const satisfies readonly { key: ClientTabActive; label: string }[];

/** The `?tab=` keys the detail page accepts — every tab that is not its own route. */
export const CLIENT_TABS = TABS.filter((tab) => !ROUTES.includes(tab.key as ClientTabRoute));

function hrefFor(clientId: string, key: ClientTabActive): string {
  return ROUTES.includes(key as ClientTabRoute)
    ? `/clients/${clientId}/${key}`
    : `/clients/${clientId}?tab=${key}`;
}

export function ClientTabs({ clientId, active }: { clientId: string; active: ClientTabActive }) {
  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b border-neutral-200">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={hrefFor(clientId, tab.key)}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm",
            tab.key === active
              ? "border-neutral-900 font-medium text-neutral-900"
              : "border-transparent text-neutral-500 hover:text-neutral-900",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
