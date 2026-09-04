import { AppNav } from "@/components/app-nav";
import { GlobalSearch } from "@/components/global-search";
import { NotificationsBell } from "@/components/notifications-bell";
import { Toaster } from "@/components/ui/sonner";
import { NAV_GROUPS } from "@/lib/nav";
import { requireAdmin } from "@/lib/session";

// The whole admin shell reads the session, so nothing here is prerenderable.
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const session = await requireAdmin();

  return (
    <div className="flex min-h-screen flex-1 bg-neutral-50 print:bg-white">
      {/* `contents` keeps the sidebar a direct flex child of this row — the
          wrapper has no box of its own — while giving `print:hidden` something
          to switch off. `/invoices/[id]/print` is a document that gets saved
          as a PDF and sent to a client's accountant; the sidebar, the search
          bar and the notifications bell must not travel with it. */}
      <div className="contents print:hidden">
        <AppNav groups={NAV_GROUPS} email={session.email} role={session.role} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3 print:hidden">
          <GlobalSearch />
          <div className="ml-auto">
            <NotificationsBell session={session} />
          </div>
        </header>

        <main className="flex-1 px-6 py-8 print:px-0 print:py-0">
          <div className="mx-auto w-full max-w-6xl print:max-w-none">{children}</div>
        </main>

        <footer className="border-t border-neutral-200 bg-white px-6 py-4 text-xs text-neutral-500 print:hidden">
          Powered by LaunchFlow
        </footer>
        {/* Pinned light: the admin shell is a white/light surface, so sonner must
            not follow the OS colour scheme and render dark toasts on it. */}
        <Toaster position="top-right" richColors theme="light" />
      </div>
    </div>
  );
}
