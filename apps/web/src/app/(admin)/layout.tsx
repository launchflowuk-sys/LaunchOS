import Link from "next/link";
import { requireAdmin } from "@/lib/session";

type NavItem = { label: string; href?: string };

// Clients, Sites and the agent-run index are Plan 2 screens; they are listed
// here so the shell matches docs/MODULE_MAP.md but render as inert placeholders
// rather than links to routes that do not exist yet.
const NAV: readonly NavItem[] = [
  { label: "Dashboard", href: "/" },
  { label: "Clients" },
  { label: "Sites" },
  { label: "Tickets", href: "/tickets" },
  { label: "Incidents", href: "/incidents" },
  { label: "Approvals", href: "/approvals" },
  { label: "Agent Runs" },
  { label: "Settings", href: "/settings/agents" },
];

// The whole admin shell reads the session, so nothing here is prerenderable.
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const session = await requireAdmin();

  return (
    <div className="flex min-h-screen flex-1 bg-neutral-50">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-neutral-200 bg-white md:flex">
        <div className="border-b border-neutral-200 px-5 py-4">
          <p className="text-sm font-semibold tracking-tight text-neutral-900">LaunchOS</p>
          <p className="mt-0.5 text-xs text-neutral-500">Admin portal</p>
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV.map((item) =>
            item.href ? (
              <Link
                key={item.label}
                href={item.href}
                className="block rounded-md px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
              >
                {item.label}
              </Link>
            ) : (
              <span
                key={item.label}
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-neutral-400"
                title="Arrives in Plan 2"
              >
                {item.label}
                <span className="text-[10px] uppercase tracking-wide">soon</span>
              </span>
            ),
          )}
        </nav>
        <div className="border-t border-neutral-200 px-5 py-4 text-xs text-neutral-500">
          <p className="truncate font-medium text-neutral-700">{session.email}</p>
          <p className="mt-0.5 capitalize">{session.role}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-6 py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
        <footer className="border-t border-neutral-200 bg-white px-6 py-4 text-xs text-neutral-500">
          Powered by LaunchFlow
        </footer>
      </div>
    </div>
  );
}
