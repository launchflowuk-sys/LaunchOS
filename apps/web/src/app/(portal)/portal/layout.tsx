import { BrandMark } from "@/components/brand-mark";
import { PortalTabs, type PortalTab } from "@/components/portal/portal-tabs";
import { SignOutButton } from "@/components/portal/sign-out-button";
import { requireClient } from "@/lib/portal-session";

const NAV: readonly PortalTab[] = [
  { label: "Overview", href: "/portal" },
  { label: "Websites", href: "/portal/sites" },
  { label: "Domains", href: "/portal/domains" },
  { label: "Progress", href: "/portal/tasks" },
  { label: "Support", href: "/portal/support" },
  { label: "Invoices", href: "/portal/invoices" },
  { label: "Plan", href: "/portal/plan" },
  { label: "Reports", href: "/portal/reports" },
  { label: "Account", href: "/portal/account" },
];

// The whole portal shell reads the session, so nothing here is prerenderable.
export const dynamic = "force-dynamic";

/**
 * The portal shell: the same white/light surface as the admin app but a single
 * top bar instead of the navy rail. A client sees a handful of screens, so a
 * sidebar would be mostly empty space.
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
    // Print rules exist for one screen in particular: `/portal/invoices/[id]`
    // is a document a client saves as a PDF and forwards to a bookkeeper. The
    // shell's own chrome — the client name bar, the nine-item nav, the signed
    // -in email address and the footer — must not travel with it, and the page
    // ground must not print as a grey field in browsers with background
    // graphics turned on. Every other portal screen prints the better for it.
    <div className="flex min-h-screen flex-1 flex-col bg-background print:bg-white">
      <header className="sticky top-0 z-30 border-b bg-card print:hidden">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          {/* The wordmark is the one piece of LaunchFlow branding above the
              fold; the name that matters on this surface is the client's, so
              the logo shrinks to 96px and takes the second line's job with it.
              The bar is `bg-card` (white), which is the only ground this asset
              can sit on directly — see `BrandMark`. */}
          <BrandMark width={96} className="shrink-0" />
          <div className="min-w-0 border-l pl-3">
            <p className="truncate text-base font-semibold tracking-tight">{session.clientName}</p>
            <p className="text-meta text-muted-foreground">Your LaunchFlow portal</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <p className="hidden max-w-64 truncate text-meta text-muted-foreground sm:block">{session.email}</p>
            <SignOutButton size="sm" />
          </div>
        </div>
        <PortalTabs tabs={NAV} />
      </header>

      {/* 16px is the portal's body size: this is read on a phone, rarely, by
          somebody who does not use it every day. Components that set their own
          scale — tables, pills, meta lines — still do. */}
      <main className="mx-auto w-full min-w-0 max-w-5xl flex-1 px-4 py-6 text-base sm:px-6 lg:py-10 print:max-w-none print:px-0 print:py-0">
        {children}
      </main>

      <footer className="border-t bg-card px-4 py-5 text-center text-meta text-muted-foreground print:hidden">
        Powered by LaunchFlow
      </footer>
    </div>
  );
}
