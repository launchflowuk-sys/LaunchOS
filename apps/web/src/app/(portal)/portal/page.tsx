import { listSites, listTasks } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { Globe, LifeBuoy, Video } from "lucide-react";
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

  return (
    <>
      <PageHeader
        title={`Hello, ${session.name}`}
        description="Everything we are looking after for you, in one place."
      />

      <div className="grid gap-3 sm:grid-cols-3">
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
          category="delivery"
        />
        <StatCard
          label="Open requests"
          value={openRequests.length}
          hint={openRequests.length === 0 ? "Nothing waiting on us" : "We are on it"}
          href="/portal/support"
          category="support"
        />
        <StatCard
          label="Work under way"
          value={openTasks.length}
          hint={openTasks.length === 0 ? "Nothing scheduled right now" : "Jobs in progress for you"}
          href="/portal/tasks"
          category="delivery"
        />
      </div>

      {/* A call with us, self-booked. `/book` reads the portal session on
          the server and pre-fills the name and email from it — nothing
          personal travels in the link. */}
      <Section title="Talk to us" description="A short video call, at a time that suits you.">
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Video className="size-4" strokeWidth={1.75} />
            </span>
            <div>
              <p className="text-base font-semibold">Book a call</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Pick a time and we will send a Zoom link. Your details are filled in already.
              </p>
            </div>
          </div>
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href="/book">Book a call</Link>
          </Button>
        </div>
      </Section>

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
    </>
  );
}
