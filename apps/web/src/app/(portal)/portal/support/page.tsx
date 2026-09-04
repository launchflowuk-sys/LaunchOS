import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

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
        actions={
          <Link
            href="/portal/support/new"
            className="inline-flex h-9 items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800"
          >
            New request
          </Link>
        }
      />

      {rows.length === 0 ? (
        <EmptyState>
          Nothing raised yet.{" "}
          <Link href="/portal/support/new" className="font-medium text-neutral-900 hover:underline">
            Raise your first request
          </Link>
          .
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Raised</TableHead>
                <TableHead>Last update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/portal/support/${row.id}`}
                      className="font-medium text-neutral-900 hover:underline"
                    >
                      {row.subject}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.severity} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell className="text-neutral-600">
                    {formatDateTime(row.lastMessageAt ?? row.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
