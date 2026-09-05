import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { LifeBuoy } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

type TicketRow = {
  id: string;
  subject: string;
  status: string;
  severity: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
};

const COLUMNS: readonly DataListColumn<TicketRow>[] = [
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
  { key: "severity", header: "Priority", cell: (row) => <StatusBadge value={row.severity} /> },
  { key: "raised", header: "Raised", hideOnMobile: true, cell: (row) => formatDate(row.createdAt) },
  {
    key: "updated",
    header: "Last update",
    cell: (row) => formatDateTime(row.lastMessageAt ?? row.updatedAt),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
];

export default async function PortalSupportPage() {
  const session = await requireClient();

  // Both halves of the scope are on `tickets`; the conversation is joined only
  // for its `last_message_at`, which moves when either side writes.
  //
  // `client_visible` is the third filter and it is not optional: tickets are
  // not all client-facing. The overdue sweep opens one per unpaid invoice, and
  // an agent's `tickets_create` is documented as internal — both would show
  // the client an alarming subject line over a thread that renders empty,
  // because their bodies are internal notes.
  const rows = await getDb()
    .select({
      id: schema.tickets.id,
      subject: schema.tickets.subject,
      status: schema.tickets.status,
      severity: schema.tickets.severity,
      createdAt: schema.tickets.createdAt,
      updatedAt: schema.tickets.updatedAt,
      lastMessageAt: schema.conversations.lastMessageAt,
    })
    .from(schema.tickets)
    .leftJoin(schema.conversations, eq(schema.tickets.conversationId, schema.conversations.id))
    .where(
      and(
        eq(schema.tickets.organisationId, session.organisationId),
        eq(schema.tickets.clientId, session.clientId),
        eq(schema.tickets.clientVisible, true),
      ),
    )
    .orderBy(desc(schema.tickets.createdAt));

  return (
    <>
      <PageHeader
        title="Support"
        description="Everything you have raised with us, and where each request has got to."
        category="support"
        actions={
          <Button asChild size="lg">
            <Link href="/portal/support/new">New request</Link>
          </Button>
        }
      />

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Your support requests"
        empty={
          <EmptyState
            icon={LifeBuoy}
            action={
              <Button asChild>
                <Link href="/portal/support/new">Raise a request</Link>
              </Button>
            }
          >
            Nothing raised yet. If something is not working, or you would like a change made, tell us here.
          </EmptyState>
        }
      />
    </>
  );
}
