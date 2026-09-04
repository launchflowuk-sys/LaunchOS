import Link from "next/link";
import { requireClient } from "@/lib/portal-session";

const NAV = [
  { label: "Overview", href: "/portal" },
  { label: "Websites", href: "/portal/sites" },
  { label: "Domains", href: "/portal/domains" },
  { label: "Progress", href: "/portal/tasks" },
  { label: "Support", href: "/portal/support" },
  { label: "Invoices", href: "/portal/invoices" },
  { label: "Reports", href: "/portal/reports" },
  { label: "Account", href: "/portal/account" },
] as const;

// The whole portal shell reads the session, so nothing here is prerenderable.
export const dynamic = "force-dynamic";

/**
 * The portal shell: the same white/light surface as the admin app but a single
 * top bar instead of the grouped sidebar. A client sees a handful of screens,
 * so a sidebar would be mostly empty space.
 *
 * It lives at `(portal)/portal/layout.tsx` rather than `(portal)/layout.tsx`
 * because Next types a layout by its own route: at the group root it would be
 * `LayoutProps<"/">` — the same key the admin shell already owns — while here
 * it is `LayoutProps<"/portal">`. The group holds nothing but `portal/**`, so
 * the two positions wrap exactly the same pages.
 */
export default async function PortalLayout({ children }: LayoutProps<"/portal">) {
  const session = await requireClient();

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-4 px-6 py-4">
          <div>
            <p className="text-sm font-semibold tracking-tight text-neutral-900">{session.clientName}</p>
            <p className="text-xs text-neutral-500">Client portal</p>
          </div>
          <nav aria-label="Portal" className="flex flex-wrap gap-1 md:ml-6">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <p className="ml-auto truncate text-xs text-neutral-500">{session.email}</p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>

      <footer className="border-t border-neutral-200 bg-white px-6 py-4 text-center text-xs text-neutral-500">
        Powered by LaunchFlow
      </footer>
    </div>
  );
}
