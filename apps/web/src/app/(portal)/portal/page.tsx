import { listSites, listTasks } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { CalendarDays, Globe, LifeBuoy, ListChecks, MessageCircle, Plus, Video } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SiteStatusBadge } from "@/components/portal/portal-status";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const CLOSED_TICKET_STATUSES = ["resolved", "closed"] as const;
/** Everything `task_status` offers except the two finished states. */
const ACTIVE_TASK_STATUSES = ["todo", "in_progress", "blocked", "review"] as const;

/**
 * The overview shows a shortlist, not the whole account: the tab for each
 * module is one tap away and holds the rest.
 */
const PREVIEW_ROWS = 5;

type SiteRow = { id: string; name: string; status: string };
type RequestRow = { id: string; subject: string; status: string; lastMessageAt: Date | null; updatedAt: Date };

const SITE_COLUMNS: readonly DataListColumn<SiteRow>[] = [
  { key: "name", header: "Website", primary: true, cell: (row) => row.name },
  { key: "status", header: "Status", status: true, cell: (row) => <SiteStatusBadge value={row.status} /> },
];

const REQUEST_COLUMNS: readonly DataListColumn<RequestRow>[] = [
  {
    key: "subject",
    header: "Request",
    primary: true,
    cell: (row) => (
      <Link href={`/portal/support/${row.id}`} className="hover:underline">
        {row.subject}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: "updated",
    header: "Last update",
    cell: (row) => formatDateTime(row.lastMessageAt ?? row.updatedAt),
  },
];

export default async function PortalHomePage() {
  const session = await requireClient();
  const db = getDb();
  const scope = { organisationId: session.organisationId, clientId: session.clientId };

  const [sites, openRequests, openTasks] = await Promise.all([
    listSites(db, scope.organisationId, { clientId: scope.clientId }),
    // `client_visible` is not optional: the overdue sweep opens a ticket per
    // unpaid invoice and an agent's `tickets_create` is internal by design.
    // Both are this client's by `client_id` and neither is theirs to read.
    db
      .select({
        id: schema.tickets.id,
        subject: schema.tickets.subject,
        status: schema.tickets.status,
        updatedAt: schema.tickets.updatedAt,
        lastMessageAt: schema.conversations.lastMessageAt,
      })
      .from(schema.tickets)
      .leftJoin(schema.conversations, eq(schema.tickets.conversationId, schema.conversations.id))
      .where(
        and(
          eq(schema.tickets.organisationId, scope.organisationId),
          eq(schema.tickets.clientId, scope.clientId),
          eq(schema.tickets.clientVisible, true),
          notInArray(schema.tickets.status, [...CLOSED_TICKET_STATUSES]),
        ),
      )
      .orderBy(desc(schema.tickets.createdAt)),
    listTasks(db, scope.organisationId, {
      clientId: scope.clientId,
      clientVisible: true,
      status: [...ACTIVE_TASK_STATUSES],
    }),
  ]);

  const liveSites = sites.filter((site) => site.status === "live");

  const firstName = session.name.trim().split(/\s+/)[0] || session.name;
  const allOnline = sites.length > 0 && liveSites.length === sites.length;

  return (
    <>
      {/* Not `PageHeader`: that carries the admin's category dot and a one-line
          description, and this is a greeting. A client opens the portal a few
          times a year, so the first thing it does is say hello and answer "is
          everything alright" before they have to go looking. */}
      <div className="mb-6">
        <p className="label-caps text-primary">Your LaunchFlow workspace</p>
        <h1 className="mt-1 text-title font-bold tracking-[-0.01em]">Hello, {firstName}.</h1>
        <p className="mt-1.5 text-base text-muted-foreground">
          Your websites, projects and support. All in one place.
        </p>

        {sites.length > 0 ? (
          <p className="mt-3 flex items-center gap-2 text-row">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", allOnline ? "bg-success-fg" : "bg-warning-fg")}
            />
            {allOnline
              ? `${sites.length === 1 ? "Your website is" : `${sites.length === 2 ? "Both" : `All ${sites.length}`} websites are`} online`
              : `${liveSites.length} of ${sites.length} websites online`}
          </p>
        ) : null}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg" className="max-sm:w-full">
            <Link href="/portal/support/new">
              <Plus aria-hidden strokeWidth={2} className="size-4" />
              New request
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg" className="max-sm:w-full">
            <Link href="/book">
              <CalendarDays aria-hidden strokeWidth={1.75} className="size-4" />
              Book a call
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Websites live"
          value={liveSites.length}
          hint={
            sites.length === 0
              ? "Nothing live yet"
              : liveSites.length === sites.length
                ? "All of your sites are online"
                : `${sites.length} on your account`
          }
          href="/portal/sites"
          category="overview"
          icon={Globe}
        />
        <StatCard
          label="Open requests"
          value={openRequests.length}
          hint={openRequests.length === 0 ? "Nothing waiting on us" : "We are on it"}
          href="/portal/support"
          category="support"
          icon={LifeBuoy}
        />
        <StatCard
          label="Work under way"
          value={openTasks.length}
          hint={openTasks.length === 0 ? "Nothing scheduled right now" : "Jobs in progress for you"}
          href="/portal/tasks"
          category="delivery"
          icon={ListChecks}
        />
      </div>

      {/* The work on the left, the way to a person on the right. A client
          who has come here to check something reads the left column; a client
          who has come here because something is wrong wants the right one, and
          it should not be underneath two panels of things that are fine. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
      <Section
        title="Your websites"
        description="How each site we host for you is doing."
        actions={
          sites.length > PREVIEW_ROWS ? (
            <Button asChild variant="secondary" size="sm">
              <Link href="/portal/sites">See all websites</Link>
            </Button>
          ) : null
        }
      >
        <DataList
          rows={sites.slice(0, PREVIEW_ROWS)}
          columns={SITE_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Your websites"
          empty={
            <EmptyState icon={Globe}>
              No websites on your account yet. We will add yours here as soon as it is under way.
            </EmptyState>
          }
        />
      </Section>

      <Section
        title="Open requests"
        description="Anything you have raised that we have not closed off."
        actions={
          <Button asChild size="sm">
            <Link href="/portal/support/new">Raise a request</Link>
          </Button>
        }
      >
        <DataList
          rows={openRequests.slice(0, PREVIEW_ROWS)}
          columns={REQUEST_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Open requests"
          empty={
            <EmptyState icon={LifeBuoy}>
              No open requests. Need help with something? Raise a request and we will pick it up.
            </EmptyState>
          }
        />
        {openRequests.length > PREVIEW_ROWS ? (
          <p className="mt-3 text-sm">
            <Link href="/portal/support" className="font-medium text-primary hover:underline">
              See all {openRequests.length} requests
            </Link>
          </p>
        ) : null}
        </Section>
        </div>

        {/* The one saturated surface on the page, and the only thing on it is
            a way to reach us. `/book` reads the portal session on the server
            and pre-fills the name and email — nothing personal is in the link. */}
        <aside className="min-w-0">
          <div className="rounded-[20px] bg-primary p-6 text-primary-foreground">
            <span
              aria-hidden
              className="flex size-11 items-center justify-center rounded-[14px] bg-white/15"
            >
              <Video className="size-5" strokeWidth={1.75} />
            </span>
            <h2 className="mt-4 text-figure font-bold leading-tight tracking-[-0.01em]">
              Let&rsquo;s talk about your website.
            </h2>
            <p className="mt-2 text-row text-primary-foreground/85">
              Book a short video call at a time that suits you.
            </p>
            <Button asChild size="lg" variant="secondary" className="mt-5 w-full">
              <Link href="/book">
                Book a call
                <span aria-hidden>→</span>
              </Link>
            </Button>
            <div className="mt-5 border-t border-white/20 pt-5">
              <Link href="/portal/support/new" className="flex items-start gap-3 group">
                <MessageCircle aria-hidden strokeWidth={1.75} className="mt-0.5 size-5 shrink-0" />
                <span>
                  <span className="block font-semibold group-hover:underline">Prefer to message us?</span>
                  <span className="block text-meta text-primary-foreground/80">
                    Our support team is always here to help.
                  </span>
                </span>
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
