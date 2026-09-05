import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  title: string;
  status: string;
  severity: string;
  openedAt: Date;
  siteName: string;
  siteUrl: string;
};

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "title",
    header: "Incident",
    primary: true,
    cell: (row) => (
      <Link href={`/incidents/${row.id}`} className="underline-offset-2 hover:underline">
        {row.title}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "severity", header: "Severity", cell: (row) => <StatusBadge value={row.severity} /> },
  {
    key: "site",
    header: "Site",
    cell: (row) => (
      <span className="block min-w-0">
        <span className="block break-words">{row.siteName}</span>
        <span className="block text-meta break-all text-muted-foreground">{row.siteUrl}</span>
      </span>
    ),
  },
  {
    key: "opened",
    header: "Opened",
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.openedAt),
  },
];

export default async function IncidentsPage() {
  const session = await requireAdmin();

  const rows = await getDb()
    .select({
      id: schema.incidents.id,
      title: schema.incidents.title,
      status: schema.incidents.status,
      severity: schema.incidents.severity,
      openedAt: schema.incidents.openedAt,
      siteName: schema.sites.name,
      siteUrl: schema.sites.primaryUrl,
    })
    .from(schema.incidents)
    .innerJoin(schema.sites, eq(schema.incidents.siteId, schema.sites.id))
    .where(eq(schema.incidents.organisationId, session.organisationId))
    .orderBy(desc(schema.incidents.openedAt));

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Uptime and hosting incidents across every client site."
        category="support"
      />

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Incidents"
        empty={<EmptyState icon={ShieldAlert}>No incidents. Every monitored site is healthy.</EmptyState>}
      />
    </>
  );
}
