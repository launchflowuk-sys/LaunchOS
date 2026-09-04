import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await requireAdmin();

  const reports = await getDb()
    .select({
      id: schema.clientReports.id,
      clientId: schema.clientReports.clientId,
      clientName: schema.clients.name,
      periodStart: schema.clientReports.periodStart,
      periodEnd: schema.clientReports.periodEnd,
      status: schema.clientReports.status,
      publishedAt: schema.clientReports.publishedAt,
    })
    .from(schema.clientReports)
    .innerJoin(schema.clients, eq(schema.clientReports.clientId, schema.clients.id))
    .where(eq(schema.clientReports.organisationId, session.organisationId))
    .orderBy(desc(schema.clientReports.periodStart))
    .limit(200);

  return (
    <>
      <PageHeader
        title="Reports"
        description="Monthly client reports. Publish one to make it visible in the client's portal."
      />

      {reports.length === 0 ? (
        <EmptyState>No reports yet. The monthly job drafts one per active client on the 1st.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Published</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/reports/${report.id}`} className="font-medium text-neutral-900 hover:underline">
                      {formatDate(report.periodStart)} → {formatDate(report.periodEnd)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/clients/${report.clientId}`} className="hover:underline">
                      {report.clientName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={report.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">
                    {formatDateTime(report.publishedAt)}
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
