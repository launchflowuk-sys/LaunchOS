import { schema } from "@launchos/db";
import { and, desc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
      <PageHeader title="Invoices" description="Your invoices from LaunchFlow." />

      {invoices.length === 0 ? (
        <EmptyState>No invoices yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="font-medium text-neutral-900">
                    <Link href={`/portal/invoices/${invoice.id}`} className="hover:underline">
                      {invoice.number}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDate(invoice.issuedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDate(invoice.dueAt)}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-900">
                    {formatPence(invoice.totalPence, invoice.currency)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={invoice.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {invoices.length === LIST_LIMIT ? (
        <p className="mt-3 text-xs text-neutral-500">
          Showing the {LIST_LIMIT} most recent invoices. Ask us if you need an older one.
        </p>
      ) : null}
    </>
  );
}
