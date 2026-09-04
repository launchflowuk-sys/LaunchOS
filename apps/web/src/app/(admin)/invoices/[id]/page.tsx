import { INVOICE_SEND_ACTION } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { markInvoiceAsPaid, requestSendInvoice, voidInvoiceAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();
  const db = getDb();

  // Scoped by organisation as well as id: an id from another tenant is a 404,
  // not someone else's invoice.
  const [invoice] = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.id, id),
    eq(schema.invoices.organisationId, session.organisationId),
  ));
  if (!invoice) notFound();

  const [[client], [subscription], payments, [pendingSend]] = await Promise.all([
    db.select().from(schema.clients).where(eq(schema.clients.id, invoice.clientId)),
    invoice.subscriptionId
      ? db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, invoice.subscriptionId))
      : Promise.resolve([undefined]),
    db.select().from(schema.payments)
      .where(and(
        eq(schema.payments.organisationId, session.organisationId),
        eq(schema.payments.invoiceId, invoice.id),
      ))
      .orderBy(desc(schema.payments.createdAt)),
    // The send request is an approvals row keyed by the invoice id in its
    // payload, so a queued send survives a reload rather than living in a toast.
    db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(
      eq(schema.approvals.organisationId, session.organisationId),
      eq(schema.approvals.status, "pending"),
      sql`${schema.approvals.payload}->>'action' = ${INVOICE_SEND_ACTION}`,
      sql`${schema.approvals.payload}->>'invoiceId' = ${invoice.id}`,
    )).limit(1),
  ]);

  // A settled invoice takes no further action: paid money is refunded as a
  // payment, and a void invoice is already written off.
  const settled = invoice.status === "paid" || invoice.status === "void";
  const sendable = !settled && !pendingSend;

  return (
    <>
      <PageHeader
        title={invoice.number}
        description={client?.name ?? "Unknown client"}
        actions={
          <>
            {sendable ? (
              <ActionForm action={requestSendInvoice} ariaLabel="Send this invoice" success="Send queued for approval">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Button type="submit">Send…</Button>
              </ActionForm>
            ) : null}
            {settled ? null : (
              <ActionForm action={markInvoiceAsPaid} ariaLabel="Mark this invoice paid" success="Invoice marked paid">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Button type="submit" variant="outline">
                  Mark paid
                </Button>
              </ActionForm>
            )}
            {settled ? null : (
              <ActionForm action={voidInvoiceAction} ariaLabel="Void this invoice" success="Invoice voided">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Button type="submit" variant="outline">
                  Void
                </Button>
              </ActionForm>
            )}
          </>
        }
      />

      {pendingSend ? (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This invoice is awaiting approval before it is emailed.{" "}
          <Link href="/approvals" className="underline">
            Open approvals
          </Link>
          .
        </p>
      ) : (
        <p className="mb-4 text-xs text-neutral-400">
          Sending emails the client a link to their portal invoice and needs approval first.
        </p>
      )}

      <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Field label="Status">
            <StatusBadge value={invoice.status} />
          </Field>
          <Field label="Issued">{formatDate(invoice.issuedAt)}</Field>
          <Field label="Due">{formatDate(invoice.dueAt)}</Field>
          <Field label="Paid">{formatDateTime(invoice.paidAt)}</Field>
          <Field label="Currency">{invoice.currency}</Field>
          <Field label="Subtotal">{formatPence(invoice.subtotalPence, invoice.currency)}</Field>
          <Field label="VAT">{formatPence(invoice.vatPence, invoice.currency)}</Field>
          <Field label="Total">
            <span className="font-semibold text-neutral-900">{formatPence(invoice.totalPence, invoice.currency)}</span>
          </Field>
          {subscription ? (
            <Field label="Subscription">
              {formatPence(subscription.amountPence, subscription.currency)} a month · {subscription.status.replaceAll("_", " ")}
            </Field>
          ) : null}
          {invoice.stripeInvoiceId ? <Field label="Stripe invoice">{invoice.stripeInvoiceId}</Field> : null}
        </dl>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Line items</h2>
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit</TableHead>
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lineItems.map((line, index) => (
                <TableRow key={`${line.description}-${index}`}>
                  <TableCell className="text-neutral-900">{line.description}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{line.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">
                    {formatPence(line.unitPence, invoice.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-900">
                    {formatPence(line.unitPence * line.quantity, invoice.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Payments</h2>
        {payments.length === 0 ? (
          <EmptyState>No payments recorded against this invoice.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
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
      </section>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-1 text-sm text-neutral-700">{children}</dd>
    </div>
  );
}
