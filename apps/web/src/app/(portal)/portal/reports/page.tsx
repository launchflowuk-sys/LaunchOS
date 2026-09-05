import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { FileText } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";
import { periodLabel } from "./period";

export const dynamic = "force-dynamic";

/** Newest first, so what falls off the end is the oldest — say so rather than hide it. */
const LIST_LIMIT = 200;

type ReportRow = { id: string; periodStart: string; periodEnd: string; publishedAt: Date | null };

const COLUMNS: readonly DataListColumn<ReportRow>[] = [
  {
    key: "period",
    header: "Period",
    primary: true,
    cell: (row) => (
      <Link href={`/portal/reports/${row.id}`} className="hover:underline">
        {periodLabel(row.periodStart, row.periodEnd)}
      </Link>
    ),
  },
  { key: "published", header: "Published", cell: (row) => formatDate(row.publishedAt) },
  {
    key: "open",
    header: "Open report",
    action: true,
    cell: (row) => (
      <Button asChild variant="secondary" size="sm">
        <Link href={`/portal/reports/${row.id}`}>Read report</Link>
      </Button>
    ),
  },
];

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
    .limit(LIST_LIMIT);

  return (
    <>
      <PageHeader
        title="Reports"
        description="What we did on your account, month by month."
        category="money"
      />

      <DataList
        rows={reports}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Your reports"
        empty={
          <EmptyState icon={FileText}>
            No reports published yet. We will put your first one here at the end of the month.
          </EmptyState>
        }
      />

      {reports.length === LIST_LIMIT ? (
        <p className="mt-3 text-meta text-muted-foreground">
          Showing the {LIST_LIMIT} most recent reports. Ask us if you need an older one.
        </p>
      ) : null}
    </>
  );
}
