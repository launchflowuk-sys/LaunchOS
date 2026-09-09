import { checkDiskSpace, checkWorkerDown } from "@launchos/core";
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

/**
 * The disk the whole deployment sits on, read off the same heartbeat.
 *
 * Here rather than in a job of its own because this is the code path that
 * definitely runs: a cron that stops running is silent in exactly the way that
 * let `/` reach 100% on 9 Sep 2026 and take every site on the box down with
 * it, Coolify included. `checkDiskSpace` notifies once per worsening crossing,
 * so loading the dashboard forty times in a morning is still one notification.
 *
 * Read-only from the shell's point of view: a failure is logged and the banner
 * stays quiet, exactly like the worker check above.
 */
async function diskBanner(organisationId: string): Promise<string | null> {
  try {
    const disk = await checkDiskSpace(getDb(), organisationId);
    if (!disk.warn || disk.usedPercent === null) return null;
    return `Server disk is ${disk.usedPercent}% full`
      + (disk.freeBytes === null ? "" : ` — ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GB left`)
      + ". At 100% every site on this server stops, Coolify included. Reclaim space before it gets there.";
  } catch (error) {
    console.error("[layout] disk usage could not be read", { organisationId, error });
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
  const [[pending], permissions, running, workerDown, diskLow] = await Promise.all([
    getDb()
      .select({ value: count() })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.organisationId, session.organisationId), eq(schema.approvals.status, "pending"))),
    sessionPermissions(),
    runningEntryFor(session),
    workerBanner(session.organisationId),
    diskBanner(session.organisationId),
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
        {/* 72px on a desktop, and on a phone the search drops to a full-width
            row of its own. Sharing one 375px line with the menu button, the
            clock, the bell and the avatar left it about 110px wide — a search
            box that narrow is decoration, and this one is the way into every
            record in the product. */}
        <header className="sticky top-0 z-30 border-b bg-card px-4 sm:px-6 print:hidden">
          <div className="flex h-16 items-center gap-2 sm:h-[4.5rem] sm:gap-4">
            <AppNavSheet
              email={session.email}
              role={session.role}
              pendingApprovals={pendingApprovals}
              permissions={permissions}
            />
            <div className="hidden min-w-0 flex-1 sm:block">
              <GlobalSearch />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:ml-0 sm:gap-2">
              <ClockWidget running={running} />
              <NotificationsBell session={session} />
              <AccountMenu email={session.email} role={session.role} />
            </div>
          </div>
          <div className="pb-3 sm:hidden">
            <GlobalSearch />
          </div>
        </header>

        <main className="flex-1 px-4 py-5 lg:px-8 lg:py-8 print:px-0 print:py-0">
          <div className="mx-auto w-full min-w-0 max-w-6xl print:max-w-none">
            {/* Above every screen, not only the dashboard: a worker that has
                stopped is the one fault that silently breaks everything else
                — mail, cron, agents, publishing — and it must be seen from
                wherever the owner happens to be. */}
            {/* Under the worker banner, because a dead worker stops things now
                and a filling disk stops them soon. Both can be true at once,
                and on the morning this was written both were. */}
            {diskLow ? (
              <InlineAlert tone="warning" title="Server disk is filling up" className="mb-6 print:hidden">
                {diskLow}
              </InlineAlert>
            ) : null}

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
