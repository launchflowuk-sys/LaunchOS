import Link from "next/link";
import { cn } from "@/lib/utils";

export const CLIENT_TABS = [
  { key: "overview", label: "Overview" },
  { key: "contacts", label: "Contacts & Billing" },
  { key: "sites", label: "Sites & Domains" },
  { key: "portal", label: "Portal users" },
] as const;

export type ClientTabKey = (typeof CLIENT_TABS)[number]["key"];

// Tasks, Support, Invoices and Reports tabs arrive with Plans 3, 4 and 5.
const LATER_TABS = [
  { label: "Tasks", plan: 3 },
  { label: "Support", plan: 4 },
  { label: "Invoices", plan: 5 },
  { label: "Reports", plan: 5 },
] as const;

export function ClientTabs({ clientId, active }: { clientId: string; active: ClientTabKey }) {
  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b border-neutral-200">
      {CLIENT_TABS.map((tab) => (
        <Link
          key={tab.key}
          href={`/clients/${clientId}?tab=${tab.key}`}
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
