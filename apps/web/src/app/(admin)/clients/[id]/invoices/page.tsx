import { getClient } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { RaiseInvoiceButton } from "../billing/raise-invoice-button";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

export default async function ClientInvoicesPage({ params }: PageProps<"/clients/[id]/invoices">) {
  const session = await requireAdmin();
  const { id } = await params;
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
        actions={<RaiseInvoiceButton clientId={client.id} />}
      />

      <ClientTabs clientId={client.id} active="invoices" />

      {invoices.length === 0 ? (
        <EmptyState>No invoices for this client yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
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
