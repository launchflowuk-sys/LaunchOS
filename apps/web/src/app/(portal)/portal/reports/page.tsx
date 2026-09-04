import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { periodLabel } from "./period";

export const dynamic = "force-dynamic";

export default async function PortalReportsPage() {
  const session = await requireClient();

  // Draft reports are staff work in progress; only a published one is a
  // statement the client is meant to read.
  const reports = await getDb()
    .select({
      id: schema.clientReports.id,
      periodStart: schema.clientReports.periodStart,
      periodEnd: schema.clientReports.periodEnd,
      publishedAt: schema.clientReports.publishedAt,
    })
    .from(schema.clientReports)
    .where(
      and(
        eq(schema.clientReports.organisationId, session.organisationId),
        eq(schema.clientReports.clientId, session.clientId),
        eq(schema.clientReports.status, "published"),
      ),
    )
    .orderBy(desc(schema.clientReports.periodStart))
    .limit(200);

  return (
    <>
      <PageHeader title="Reports" description="What we did on your account, month by month." />

      {reports.length === 0 ? (
        <EmptyState>No reports published yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Published</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="font-medium text-neutral-900">
                    <Link href={`/portal/reports/${report.id}`} className="hover:underline">
                      {periodLabel(report.periodStart, report.periodEnd)}
                    </Link>
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
