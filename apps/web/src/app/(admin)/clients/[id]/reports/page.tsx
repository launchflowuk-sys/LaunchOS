import { getClient, listClientReports } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

export default async function ClientReportsPage({ params }: PageProps<"/clients/[id]/reports">) {
  const session = await requireAdmin();
  const { id } = await params;
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const reports = await listClientReports(db, session.organisationId, { clientId: id, limit: 200 });

  return (
    <>
      <PageHeader
        title={client.name}
        description="Monthly reports for this client. A published report is visible in their portal."
      />

      <ClientTabs clientId={client.id} active="reports" />

      {reports.length === 0 ? (
        <EmptyState>No reports for this client yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
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
