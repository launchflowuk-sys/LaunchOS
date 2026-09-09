import { BrandMark } from "@/components/brand-mark";
import { PortalAccountMenu } from "@/components/portal/portal-account-menu";
import { PortalBell } from "@/components/portal/portal-bell";
import { PortalHelpCard, PortalNavList } from "@/components/portal/portal-rail";
import { PortalRailSheet } from "@/components/portal/portal-rail-sheet";
import { PortalSearch } from "@/components/portal/portal-search";
import { requireClient } from "@/lib/portal-session";

// The whole portal shell reads the session, so nothing here is prerenderable.
export const dynamic = "force-dynamic";

/** "Thurrock Express Taxis" → "TE". */
function businessInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}

/**
 * The portal shell: a white rail beside the work, and a bar that says whose
 * portal this is.
 *
 * The rail is white rather than the admin's navy on purpose. A client is a
 * guest: the surface should read as their workspace, not as the inside of
 * somebody else's tooling, and the one saturated thing on screen is the item
 * they are standing on.
 *
 * Print rules exist for one screen in particular. `/portal/invoices/[id]` is a
 * document a client saves as a PDF and forwards to a bookkeeper: the rail, the
 * bar and the footer must not travel with it.
 */
export default async function PortalLayout({ children }: LayoutProps<"/portal">) {
  const session = await requireClient();

  return (
    <div className="flex min-h-screen flex-1 bg-background print:block print:bg-white">
      {/* `contents` keeps the rail a direct flex child of the row while giving
          `print:hidden` something to switch off. */}
      <div className="contents print:hidden">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-card lg:flex">
          <div className="px-5 py-5">
            <BrandMark width={140} />
            <p className="label-caps mt-1.5 text-muted-foreground">Client portal</p>
          </div>
          <PortalNavList />
          <PortalHelpCard />
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b bg-card px-4 sm:px-6 print:hidden">
          <div className="flex h-16 items-center gap-3 sm:h-20 sm:gap-4">
            <PortalRailSheet />

            {/* Whose portal this is. The client's name is the one that matters
                on this surface, so it takes the position the product name would
                normally hold. */}
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-row font-semibold text-background">
                {businessInitials(session.clientName)}
              </span>
              <span className="min-w-0">
                <span className="label-caps block text-muted-foreground">Your business</span>
                <span className="block truncate text-base font-semibold tracking-tight">{session.clientName}</span>
              </span>
            </div>

            {/* The search takes the middle of the bar from `md` up. Below that
                the business name and the account button already fill the row,
                and a third control would push one of them off the edge. */}
            <div className="mx-auto hidden w-full max-w-md min-w-0 md:block">
              <PortalSearch />
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3 md:ml-0">
              <PortalBell session={session} />
              <PortalAccountMenu name={session.name} email={session.email} />
            </div>
          </div>
        </header>

        {/* 16px is the portal's body size: this is read on a phone, rarely, by
            somebody who does not use it every day. Components that set their
            own scale — tables, pills, meta lines — still do. */}
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 text-base sm:px-8 lg:py-8 print:max-w-none print:px-0 print:py-0">
          {children}
        </main>

        <footer className="border-t bg-card px-4 py-5 text-center text-meta text-muted-foreground print:hidden">
          Powered by LaunchFlow
        </footer>
      </div>
    </div>
  );
}
