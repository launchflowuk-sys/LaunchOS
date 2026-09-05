import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { ChartLine } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

type ReportRow = {
  id: string;
  clientId: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  publishedAt: Date | null;
};

const COLUMNS: readonly DataListColumn<ReportRow>[] = [
  {
    key: "period",
    header: "Period",
    primary: true,
    cell: (report) => (
      <Link href={`/reports/${report.id}`} className="whitespace-nowrap hover:underline">
        {formatDate(report.periodStart)} → {formatDate(report.periodEnd)}
      </Link>
    ),
  },
  {
    key: "client",
    header: "Client",
    cell: (report) => (
      <Link href={`/clients/${report.clientId}`} className="hover:underline">
        {report.clientName}
      </Link>
    ),
  },
  {
    key: "published",
    header: "Published",
    cell: (report) => <span className="whitespace-nowrap">{formatDateTime(report.publishedAt)}</span>,
  },
  { key: "status", header: "Status", status: true, cell: (report) => <StatusBadge value={report.status} /> },
];

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
        category="money"
      />

      <DataList<ReportRow>
        rows={reports}
        columns={COLUMNS}
        getRowKey={(report) => report.id}
        caption="Client reports"
        empty={
          <EmptyState icon={ChartLine}>
            No reports yet. The monthly job drafts one per active client on the 1st.
          </EmptyState>
        }
      />
    </>
  );
}
