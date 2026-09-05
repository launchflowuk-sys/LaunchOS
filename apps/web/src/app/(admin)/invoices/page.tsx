import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { Receipt } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { INVOICE_STATUSES, InvoiceStatusFilter } from "./schemas";

export const dynamic = "force-dynamic";

/**
 * The status filter is a row of links rather than a select: it is the only
 * control on the screen, every option is one tap, and a GET link keeps the
 * filtered list shareable and reloadable.
 */
const FILTER_BASE =
  "rounded-full border px-3 py-1 text-row transition-colors";
const FILTER_ON = "border-primary bg-primary text-primary-foreground";
const FILTER_OFF = "border-border bg-card text-muted-foreground hover:bg-muted";

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  issuedAt: Date;
  dueAt: Date;
  totalPence: number;
  currency: string;
  clientId: string;
  clientName: string;
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
  {
    key: "client",
    header: "Client",
    cell: (row) => (
      <Link href={`/clients/${row.clientId}`} className="hover:underline">
        {row.clientName}
      </Link>
    ),
  },
  { key: "issued", header: "Issued", cell: (row) => <span className="whitespace-nowrap">{formatDate(row.issuedAt)}</span> },
  { key: "due", header: "Due", cell: (row) => <span className="whitespace-nowrap">{formatDate(row.dueAt)}</span> },
  {
    key: "total",
    header: "Total",
    numeric: true,
    className: "font-medium text-foreground",
    cell: (row) => formatPence(row.totalPence, row.currency),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
];

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const session = await requireAdmin();
  const { status } = await searchParams;
  const active = InvoiceStatusFilter.parse(Array.isArray(status) ? status[0] : status);

  const scope = eq(schema.invoices.organisationId, session.organisationId);
  const invoices = await getDb()
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      status: schema.invoices.status,
      issuedAt: schema.invoices.issuedAt,
      dueAt: schema.invoices.dueAt,
      totalPence: schema.invoices.totalPence,
      currency: schema.invoices.currency,
      clientId: schema.invoices.clientId,
      clientName: schema.clients.name,
    })
    .from(schema.invoices)
    .innerJoin(schema.clients, eq(schema.invoices.clientId, schema.clients.id))
    .where(active ? and(scope, eq(schema.invoices.status, active)) : scope)
    .orderBy(desc(schema.invoices.issuedAt))
    .limit(200);

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Every invoice raised for a client, and where it has got to."
        category="money"
      />

      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2">
        <Link href="/invoices" className={cn(FILTER_BASE, active ? FILTER_OFF : FILTER_ON)}>
          all
        </Link>
        {INVOICE_STATUSES.map((value) => (
          <Link
            key={value}
            href={`/invoices?status=${value}`}
            className={cn(FILTER_BASE, value === active ? FILTER_ON : FILTER_OFF)}
          >
            {value}
          </Link>
        ))}
      </nav>

      <DataList<InvoiceRow>
        rows={invoices}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Invoices"
        empty={
          <EmptyState icon={Receipt}>
            No invoices yet. Raise one from a client&apos;s Contacts &amp; Billing tab.
          </EmptyState>
        }
      />
    </>
  );
}
