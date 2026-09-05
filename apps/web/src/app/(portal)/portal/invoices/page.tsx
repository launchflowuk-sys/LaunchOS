import { schema } from "@launchos/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { Receipt } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

/**
 * Newest first, so what falls off the end is the oldest. At one retainer
 * invoice a month that is sixteen years of history, but a client who cannot
 * find an old invoice is told why rather than left to guess.
 */
const LIST_LIMIT = 200;

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  issuedAt: Date;
  dueAt: Date;
  totalPence: number;
  currency: string;
};

const COLUMNS: readonly DataListColumn<InvoiceRow>[] = [
  {
    key: "number",
    header: "Invoice",
    primary: true,
    cell: (row) => (
      <Link href={`/portal/invoices/${row.id}`} className="hover:underline">
        {row.number}
      </Link>
    ),
  },
  { key: "issued", header: "Issued", hideOnMobile: true, cell: (row) => formatDate(row.issuedAt) },
  { key: "due", header: "Due", cell: (row) => formatDate(row.dueAt) },
  {
    key: "total",
    header: "Total",
    numeric: true,
    className: "font-medium text-foreground",
    cell: (row) => formatPence(row.totalPence, row.currency),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: "open",
    header: "Open invoice",
    action: true,
    cell: (row) => (
      <Button asChild variant="secondary" size="sm">
        <Link href={`/portal/invoices/${row.id}`}>View invoice</Link>
      </Button>
    ),
  },
];

export default async function PortalInvoicesPage() {
  const session = await requireClient();

  // Both halves of the scope come from the session. A draft is an invoice that
  // has not been agreed with the client yet, so it must never appear here —
  // the client would be reading a number we are still deciding on.
  const invoices = await getDb()
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
    .where(
      and(
        eq(schema.invoices.organisationId, session.organisationId),
        eq(schema.invoices.clientId, session.clientId),
        ne(schema.invoices.status, "draft"),
      ),
    )
    .orderBy(desc(schema.invoices.issuedAt))
    .limit(LIST_LIMIT);

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Your invoices from LaunchFlow. Open one to print it or save it as a PDF."
        category="money"
      />

      <DataList
        rows={invoices}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Your invoices"
        empty={<EmptyState icon={Receipt}>No invoices yet. There is nothing for you to pay.</EmptyState>}
      />

      {invoices.length === LIST_LIMIT ? (
        <p className="mt-3 text-meta text-muted-foreground">
          Showing the {LIST_LIMIT} most recent invoices. Ask us if you need an older one.
        </p>
      ) : null}
    </>
  );
}
