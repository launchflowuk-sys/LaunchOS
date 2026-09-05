import { getClient, listClientReports } from "@launchos/core";
import { FileText } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

type ReportRow = Awaited<ReturnType<typeof listClientReports>>[number];

const COLUMNS: readonly DataListColumn<ReportRow>[] = [
  {
    key: "period",
    header: "Period",
    primary: true,
    className: "whitespace-nowrap",
    cell: (row) => (
      <Link href={`/reports/${row.id}`} className="hover:underline">
        {formatDate(row.periodStart)} → {formatDate(row.periodEnd)}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: "published",
    header: "Published",
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.publishedAt),
  },
];

export default async function ClientReportsPage({ params }: PageProps<"/clients/[id]/reports">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const reports = await listClientReports(db, session.organisationId, { clientId: id, limit: 200 });

  return (
    <>
      <PageHeader
        title={client.name}
        description="Monthly reports for this client. A published report is visible in their portal."
        category="delivery"
      />

      <ClientTabs clientId={client.id} active="reports" />

      <DataList
        rows={reports}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Reports"
        empty={<EmptyState icon={FileText}>No reports for this client yet.</EmptyState>}
      />
    </>
  );
}
