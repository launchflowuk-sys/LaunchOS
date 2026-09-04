import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { INVOICE_STATUSES, InvoiceStatusFilter } from "./schemas";

export const dynamic = "force-dynamic";

const FILTER_BASE = "rounded-md px-3 py-1.5 text-sm capitalize";

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
      <PageHeader title="Invoices" description="Every invoice raised for a client, and where it has got to." />

      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2">
        <Link
          href="/invoices"
          className={cn(FILTER_BASE, active ? "border border-neutral-200 text-neutral-700" : "bg-neutral-900 text-white")}
        >
          All
        </Link>
        {INVOICE_STATUSES.map((value) => (
          <Link
            key={value}
            href={`/invoices?status=${value}`}
            className={cn(FILTER_BASE, value === active ? "bg-neutral-900 text-white" : "border border-neutral-200 text-neutral-700")}
          >
            {value}
          </Link>
        ))}
      </nav>

      {invoices.length === 0 ? (
        <EmptyState>No invoices yet. Raise one from a client&apos;s Contacts &amp; Billing tab.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    <Link href={`/invoices/${invoice.id}`} className="font-medium text-neutral-900 hover:underline">
                      {invoice.number}
                    </Link>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/clients/${invoice.clientId}`} className="hover:underline">
                      {invoice.clientName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={invoice.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDate(invoice.issuedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDate(invoice.dueAt)}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-900">
                    {formatPence(invoice.totalPence, invoice.currency)}
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
