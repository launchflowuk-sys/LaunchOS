import { checkWorkerDown } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, count, eq } from "drizzle-orm";
import { AccountMenu } from "@/components/account-menu";
import { AppNav, AppNavSheet } from "@/components/app-nav";
import { ClockWidget } from "@/components/clock-widget";
import { GlobalSearch } from "@/components/global-search";
import { InlineAlert } from "@/components/inline-alert";
import { NotificationsBell } from "@/components/notifications-bell";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { Toaster } from "@/components/ui/sonner";
import { getDb } from "@/lib/db";
import { sessionPermissions } from "@/lib/permissions";
import { requireAdmin } from "@/lib/session";
import { workerDownMessage } from "@/lib/worker-status";
import { runningEntryFor } from "./time/running";

// The whole admin shell reads the session, so nothing here is prerenderable.
export const dynamic = "force-dynamic";

/**
 * Is the background worker alive? `checkWorkerDown` also raises the
 * `worker.down` notification once per outage. A failure *reading* the
 * heartbeat must not take the whole shell down with it, so it is logged and
 * the banner stays quiet for that render.
 */
async function workerBanner(organisationId: string): Promise<string | null> {
  try {
    return workerDownMessage(await checkWorkerDown(getDb(), organisationId));
  } catch (error) {
    console.error("[layout] worker heartbeat could not be read", { organisationId, error });
    return null;
  }
}

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  // The shell itself must stay reachable when an organisation requires a
  // second factor this member has not set up yet: the screen that fixes it —
  // /account — renders inside this layout, and a gate here would bounce it
  // back to itself. Every page and action inside still applies the gate.
  const session = await requireAdmin({ allowPendingEnrolment: true });

  // The one number the rail carries. Approvals is where every outward action
  // stops for a human, so the count travels with the shell rather than living
  // only on the screen the owner has to remember to open.
  // Alongside it: what this member may see (which decides the rail), whether
  // they are clocked in (the top bar's clock), and whether the worker is
  // still checking in (the banner), one indexed query each.
  const [[pending], permissions, running, workerDown] = await Promise.all([
    getDb()
      .select({ value: count() })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.organisationId, session.organisationId), eq(schema.approvals.status, "pending"))),
    sessionPermissions(),
    runningEntryFor(session),
    workerBanner(session.organisationId),
  ]);
  const pendingApprovals = pending?.value ?? 0;

  return (
    <div className="flex min-h-screen flex-1 bg-background print:bg-white">
      {/* `contents` keeps the sidebar a direct flex child of this row — the
          wrapper has no box of its own — while giving `print:hidden` something
          to switch off. `/invoices/[id]/print` is a document that gets saved
          as a PDF and sent to a client's accountant; the sidebar, the search
          bar and the notifications bell must not travel with it. */}
      <div className="contents print:hidden">
        <AppNav
          email={session.email}
          role={session.role}
          pendingApprovals={pendingApprovals}
          permissions={permissions}
        />
      </div>

      {/* `min-w-0` is what stops a wide table inside a page from pushing the
          whole column past the viewport: without it a flex child sizes to its
          content, and DataList's own `overflow-x-auto` never gets to scroll. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card px-4 py-2.5 sm:gap-3 sm:px-6 print:hidden">
          <AppNavSheet
            email={session.email}
            role={session.role}
            pendingApprovals={pendingApprovals}
            permissions={permissions}
          />
          <div className="min-w-0 flex-1">
            <GlobalSearch />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ClockWidget running={running} />
            <NotificationsBell session={session} />
            <AccountMenu email={session.email} role={session.role} />
          </div>
        </header>

        <main className="flex-1 px-4 py-5 lg:px-8 lg:py-8 print:px-0 print:py-0">
          <div className="mx-auto w-full min-w-0 max-w-6xl print:max-w-none">
            {/* Above every screen, not only the dashboard: a worker that has
                stopped is the one fault that silently breaks everything else
                — mail, cron, agents, publishing — and it must be seen from
                wherever the owner happens to be. */}
            {workerDown ? (
              <InlineAlert tone="danger" title="Background worker is not running" className="mb-6 print:hidden">
                {workerDown} Check the worker service in Coolify.
              </InlineAlert>
            ) : null}
            {children}
          </div>
        </main>
        {/* Registers public/sw.js for web push. Asks for nothing; /account holds the switch. */}
        <ServiceWorkerRegister />

        <footer className="border-t bg-card px-4 py-4 text-meta text-muted-foreground sm:px-8 print:hidden">
          Powered by LaunchFlow
        </footer>
        {/* Pinned light: the admin shell is a white/light surface, so sonner must
            not follow the OS colour scheme and render dark toasts on it. */}
        <Toaster position="top-right" richColors theme="light" />
      </div>
    </div>
  );
}
