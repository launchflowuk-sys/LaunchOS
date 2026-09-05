import { getClient } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { Receipt } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { RaiseInvoiceButton } from "../billing/raise-invoice-button";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  totalPence: number;
  currency: string;
};

const COLUMNS: readonly DataListColumn<InvoiceRow>[] = [
  {
    key: "number",
    header: "Number",
    primary: true,
    cell: (row) => (
      <Link href={`/invoices/${row.id}`} className="hover:underline">
        {row.number}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "issued", header: "Issued", cell: (row) => formatDate(row.issuedAt), className: "whitespace-nowrap" },
  { key: "due", header: "Due", cell: (row) => formatDate(row.dueAt), className: "whitespace-nowrap" },
  {
    key: "total",
    header: "Total",
    numeric: true,
    className: "font-medium text-foreground",
    cell: (row) => formatPence(row.totalPence, row.currency),
  },
];

export default async function ClientInvoicesPage({ params }: PageProps<"/clients/[id]/invoices">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const invoices = await db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      status: schema.invoices.status,
      issuedAt: schema.invoices.issuedAt,
      dueAt: schema.invoices.dueAt,
      totalPence: schema.invoices.totalPence,
      currency: schema.invoices.currency,
    })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.organisationId, session.organisationId), eq(schema.invoices.clientId, id)))
    .orderBy(desc(schema.invoices.issuedAt))
    .limit(200);

  return (
    <>
      <PageHeader
        title={client.name}
        description="Every invoice raised for this client."
        category="delivery"
        actions={<RaiseInvoiceButton clientId={client.id} />}
      />

      <ClientTabs clientId={client.id} active="invoices" />

      <DataList
        rows={invoices}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Invoices"
        empty={<EmptyState icon={Receipt}>No invoices for this client yet. Raise one from the header.</EmptyState>}
      />
    </>
  );
}
