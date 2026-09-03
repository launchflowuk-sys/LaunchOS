import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TicketsPage() {
  const session = await requireAdmin();

  const rows = await getDb()
    .select({
      id: schema.tickets.id,
      subject: schema.tickets.subject,
      severity: schema.tickets.severity,
      status: schema.tickets.status,
      source: schema.tickets.source,
      createdAt: schema.tickets.createdAt,
      clientName: schema.clients.name,
    })
    .from(schema.tickets)
    .innerJoin(schema.clients, eq(schema.tickets.clientId, schema.clients.id))
    .where(eq(schema.tickets.organisationId, session.organisationId))
    .orderBy(desc(schema.tickets.createdAt));

  return (
    <>
      <PageHeader title="Tickets" description="Support work raised by clients, monitors and agents." />

      {rows.length === 0 ? (
        <EmptyState>No tickets yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-neutral-900">{row.subject}</TableCell>
                  <TableCell>
                    <StatusBadge value={row.severity} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.source}</TableCell>
                  <TableCell className="text-neutral-600">{row.clientName}</TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(row.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
