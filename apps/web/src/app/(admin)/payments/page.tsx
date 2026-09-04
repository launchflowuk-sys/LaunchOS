import { listClients } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { RecordPaymentDialog } from "./record-payment-dialog";
import { PAYMENT_PROVIDERS } from "./schemas";

export const dynamic = "force-dynamic";

/** An invoice can still take money until it is settled or written off. */
const UNPAID = ["draft", "sent", "overdue"] as const;

export default async function PaymentsPage() {
  const session = await requireAdmin();
  const db = getDb();

  const [payments, clients, openInvoices] = await Promise.all([
    db
      .select({
        id: schema.payments.id,
        amountPence: schema.payments.amountPence,
        currency: schema.payments.currency,
        provider: schema.payments.provider,
        providerRef: schema.payments.providerRef,
        status: schema.payments.status,
        paidAt: schema.payments.paidAt,
        createdAt: schema.payments.createdAt,
        clientId: schema.payments.clientId,
        clientName: schema.clients.name,
        invoiceId: schema.payments.invoiceId,
        invoiceNumber: schema.invoices.number,
      })
      .from(schema.payments)
      .innerJoin(schema.clients, eq(schema.payments.clientId, schema.clients.id))
      .leftJoin(schema.invoices, eq(schema.payments.invoiceId, schema.invoices.id))
      .where(eq(schema.payments.organisationId, session.organisationId))
      // Postgres sorts NULLs first under DESC; a payment with no paidAt is not
      // settled money and belongs below the dated rows, so the default is
      // overridden and createdAt breaks the tie between them.
      .orderBy(sql`${schema.payments.paidAt} desc nulls last`, desc(schema.payments.createdAt))
      .limit(200),
    listClients(db, session.organisationId, { status: "active", limit: 200 }),
    db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        totalPence: schema.invoices.totalPence,
        currency: schema.invoices.currency,
        clientName: schema.clients.name,
      })
      .from(schema.invoices)
      .innerJoin(schema.clients, eq(schema.invoices.clientId, schema.clients.id))
      .where(and(
        eq(schema.invoices.organisationId, session.organisationId),
        inArray(schema.invoices.status, [...UNPAID]),
      ))
      .orderBy(desc(schema.invoices.issuedAt))
      .limit(200),
  ]);

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every payment recorded against a client, from Stripe or by hand."
        actions={
          <RecordPaymentDialog
            clients={clients.map((c) => ({ value: c.id, label: c.name }))}
            invoices={openInvoices.map((i) => ({
              value: i.id,
              label: `${i.number} — ${i.clientName} — ${formatPence(i.totalPence, i.currency)}`,
            }))}
            providers={PAYMENT_PROVIDERS}
          />
        }
      />

      {payments.length === 0 ? (
        <EmptyState>No payments recorded yet. Record one above once money lands.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell className="whitespace-nowrap text-neutral-600">
                    {formatDateTime(payment.paidAt ?? payment.createdAt)}
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/clients/${payment.clientId}`} className="hover:underline">
                      {payment.clientName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    {payment.invoiceId ? (
                      <Link href={`/invoices/${payment.invoiceId}`} className="hover:underline">
                        {payment.invoiceNumber}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-900">
                    {formatPence(payment.amountPence, payment.currency)}
                  </TableCell>
                  <TableCell className="text-neutral-600">{payment.provider}</TableCell>
                  <TableCell className="text-neutral-600">{payment.providerRef ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge value={payment.status} />
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
