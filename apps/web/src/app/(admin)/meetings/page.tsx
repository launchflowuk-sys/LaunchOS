import { listMeetings, type MeetingRow } from "@launchos/core";
import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatInZone } from "@/lib/booking/slot-days";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { MeetingStatusBadge } from "./meeting-status-badge";
import { MEETING_KIND_LABEL } from "./schemas";

export const dynamic = "force-dynamic";

const SCOPES = ["upcoming", "past"] as const;
type Scope = (typeof SCOPES)[number];

/** Every time on this screen is London: the diary is Shoji's, wherever the guest is. */
const HOST_ZONE = "Europe/London";

const COLUMNS: readonly DataListColumn<MeetingRow>[] = [
  {
    key: "guest",
    header: "Guest",
    primary: true,
    cell: (row) => (
      <>
        <Link href={`/meetings/${row.id}`} className="hover:underline">
          {row.guestName}
        </Link>
        <span className="block text-meta font-normal break-all text-muted-foreground">{row.guestEmail}</span>
      </>
    ),
  },
  { key: "when", header: "When (London)", className: "whitespace-nowrap", cell: (row) => formatInZone(row.startsAt, HOST_ZONE, "short") },
  { key: "kind", header: "Kind", cell: (row) => MEETING_KIND_LABEL[row.kind] },
  {
    key: "join",
    header: "Join",
    cell: (row) =>
      row.status === "scheduled" || row.status === "rescheduled" ? (
        <a href={row.hostUrl ?? row.joinUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          Join link
        </a>
      ) : (
        "—"
      ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <MeetingStatusBadge status={row.status} /> },
  {
    key: "open",
    header: "Open",
    action: true,
    cell: (row) => (
      <Button asChild variant="secondary" size="sm">
        <Link href={`/meetings/${row.id}`}>Open</Link>
      </Button>
    ),
  },
];

export default async function MeetingsPage({ searchParams }: PageProps<"/meetings">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const requested = typeof params.scope === "string" ? params.scope : "upcoming";
  const scope: Scope = SCOPES.includes(requested as Scope) ? (requested as Scope) : "upcoming";

  const rows = await listMeetings(getDb(), session.organisationId, { scope, limit: 200 });

  return (
    <>
      <PageHeader
        title="Meetings"
        description="Discovery calls booked through the booking page, on Zoom. Mark how each one went so the follow-up goes out."
        category="delivery"
        actions={
          <Button asChild variant="secondary">
            <Link href="/book" target="_blank" rel="noreferrer">
              Open the booking page
            </Link>
          </Button>
        }
      />

      {/* Two tabs, as links: each is its own URL, and a refresh keeps the tab. */}
      <div className="mb-4 border-b">
        <div className="-mb-px flex gap-1" role="tablist" aria-label="Meetings">
          {SCOPES.map((key) => (
            <Link
              key={key}
              href={{ pathname: "/meetings", query: { scope: key } }}
              role="tab"
              aria-selected={key === scope}
              aria-current={key === scope ? "page" : undefined}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                key === scope ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {key === "upcoming" ? "Upcoming" : "Past"}
            </Link>
          ))}
        </div>
      </div>

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption={scope === "upcoming" ? "Upcoming meetings" : "Past meetings"}
        empty={
          <EmptyState icon={CalendarClock}>
            {scope === "upcoming"
              ? "Nothing booked. Calls land here when a lead or client picks a time on the booking page."
              : "No past meetings yet."}
          </EmptyState>
        }
      />
    </>
  );
}
