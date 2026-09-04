import Link from "next/link";
import { cn } from "@/lib/utils";

/** Sections the client detail page renders itself, chosen with `?tab=`. */
export type ClientTabKey = "overview" | "contacts" | "sites" | "portal";

/**
 * Tasks is a route of its own (`/clients/[id]/tasks`) rather than a `?tab=`
 * section: it owns phase progress, task generation and per-task forms, which
 * would push the detail page well past the file-size rule.
 */
export type ClientTabActive = ClientTabKey | "tasks";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "contacts", label: "Contacts & Billing" },
  { key: "sites", label: "Sites & Domains" },
  { key: "tasks", label: "Tasks" },
  { key: "portal", label: "Portal users" },
] as const satisfies readonly { key: ClientTabActive; label: string }[];

/** The `?tab=` keys the detail page accepts — every tab except Tasks. */
export const CLIENT_TABS = TABS.filter((tab) => tab.key !== "tasks");

function hrefFor(clientId: string, key: ClientTabActive): string {
  return key === "tasks" ? `/clients/${clientId}/tasks` : `/clients/${clientId}?tab=${key}`;
}

// Support, Invoices and Reports tabs arrive with Plans 4 and 5.
const LATER_TABS = [
  { label: "Support", plan: 4 },
  { label: "Invoices", plan: 5 },
  { label: "Reports", plan: 5 },
] as const;

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
      {LATER_TABS.map((tab) => (
        <span key={tab.label} title={`Arrives in Plan ${tab.plan}`} className="px-3 py-2 text-sm text-neutral-300">
          {tab.label}
        </span>
      ))}
    </div>
  );
}
