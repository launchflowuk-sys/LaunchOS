import { listArchivedClients } from "@launchos/core";
import { Archive } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { RestoreClientButton } from "./restore-client-button";

export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listArchivedClients>>[number];

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "name",
    header: "Client",
    cell: (row) => (
      <Link href={`/clients/${row.id}`} className="font-medium text-primary hover:underline">
        {row.name}
      </Link>
    ),
  },
  { key: "email", header: "Email", hideOnMobile: true, cell: (row) => row.email ?? "—" },
  {
    key: "archived",
    header: "Archived",
    hideOnMobile: true,
    cell: (row) => <span className="tabular-nums">{formatDateTime(row.updatedAt)}</span>,
  },
  {
    key: "restore",
    header: "",
    cell: (row) => <RestoreClientButton clientId={row.id} clientName={row.name} />,
  },
];

/**
 * Where archived clients go, and how they come back.
 *
 * Archiving already kept everything — it only sets a status — but there was
 * nowhere to see what had been archived, so it behaved like deletion with
 * extra steps. This is the other half of it.
 *
 * Deleted clients are deliberately absent: a delete cascades twenty-four
 * tables and leaves no row to list. What it leaves is an `audit_log` entry
 * holding the client record and the report of what went with it, which is a
 * record, not a restore. Nothing here pretends otherwise.
 */
export default async function ClientArchivePage() {
  const session = await requireAdmin();
  const rows = await listArchivedClients(getDb(), session.organisationId);

  return (
    <>
      <PageHeader
        wide
        title="Archived clients"
        description="Archived clients keep everything — invoices, sites, history. Restore one to put it back on the active list."
        category="organisation"
      />
      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Archived clients"
        empty={<EmptyState icon={Archive}>Nothing archived. Archived clients appear here and can be restored.</EmptyState>}
      />
    </>
  );
}
