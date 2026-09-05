import { INVOICE_SEND_ACTION } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { Banknote } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue, type KeyValueItem } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime, formatPence } from "@/lib/format";
import { readSendFailure } from "@/lib/send-status";
import { requireAdmin } from "@/lib/session";
import { markInvoiceAsPaid, requestSendInvoice, voidInvoiceAction } from "../actions";

export const dynamic = "force-dynamic";

type LineRow = { description: string; quantity: number; unitPence: number };
type PaymentRow = {
  id: string;
  amountPence: number;
  currency: string;
  provider: string;
  providerRef: string | null;
  status: string;
  paidAt: Date | null;
  createdAt: Date;
};

function lineColumns(currency: string): readonly DataListColumn<LineRow>[] {
  return [
    { key: "description", header: "Description", primary: true, cell: (line) => line.description },
    { key: "qty", header: "Qty", numeric: true, cell: (line) => line.quantity },
    { key: "unit", header: "Unit", numeric: true, cell: (line) => formatPence(line.unitPence, currency) },
    {
      key: "total",
      header: "Line total",
      numeric: true,
      className: "font-medium text-foreground",
      cell: (line) => formatPence(line.unitPence * line.quantity, currency),
    },
  ];
}

const PAYMENT_COLUMNS: readonly DataListColumn<PaymentRow>[] = [
  {
    key: "date",
    header: "Date",
    primary: true,
    cell: (row) => <span className="whitespace-nowrap">{formatDateTime(row.paidAt ?? row.createdAt)}</span>,
  },
  {
    key: "amount",
    header: "Amount",
    numeric: true,
    className: "font-medium text-foreground",
    cell: (row) => formatPence(row.amountPence, row.currency),
  },
  { key: "provider", header: "Provider", cell: (row) => row.provider },
  { key: "reference", header: "Reference", cell: (row) => row.providerRef ?? "—" },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
];

export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();
  const db = getDb();

  // A non-uuid reaches Postgres as a cast error rather than a miss, so it is
  // parsed here: /invoices/foo is a 404, not an unhandled 500.
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) notFound();

  // Scoped by organisation as well as id: an id from another tenant is a 404,
  // not someone else's invoice.
  const [invoice] = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.id, parsedId.data),
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
  // The send claim is kept when the provider rejects the message, so the status
  // still reads "sent" and nothing else on this screen would say the client
  // never got it. The approval that authorised that send is spent; getting the
  // invoice out needs a fresh one.
  const sendFailure = readSendFailure(invoice.metadata);

  const details: KeyValueItem[] = [
    { label: "Status", value: <StatusBadge value={invoice.status} /> },
    { label: "Issued", value: formatDate(invoice.issuedAt) },
    { label: "Due", value: formatDate(invoice.dueAt) },
    { label: "Paid", value: formatDateTime(invoice.paidAt) },
    { label: "Currency", value: invoice.currency },
    { label: "Subtotal", value: <span className="tabular-nums">{formatPence(invoice.subtotalPence, invoice.currency)}</span> },
    { label: "VAT", value: <span className="tabular-nums">{formatPence(invoice.vatPence, invoice.currency)}</span> },
    {
      label: "Total",
      value: (
        <span className="text-base font-semibold tabular-nums">
          {formatPence(invoice.totalPence, invoice.currency)}
        </span>
      ),
    },
    ...(subscription
      ? [{
          label: "Subscription",
          value: `${formatPence(subscription.amountPence, subscription.currency)} a month · ${subscription.status.replaceAll("_", " ")}`,
        }]
      : []),
    ...(invoice.stripeInvoiceId ? [{ label: "Stripe invoice", value: invoice.stripeInvoiceId }] : []),
  ];

  return (
    <>
      <PageHeader
        title={invoice.number}
        description={client?.name ?? "Unknown client"}
        category="money"
        /* Two actions only. Sending is the one thing this screen is for, and
           printing is how an invoice reaches a client who never signs in.
           Marking paid and voiding change what the invoice *is*, so they sit
           with the figures they change, at the foot of the detail card. */
        actions={
          <>
            {sendable ? (
              <ActionForm action={requestSendInvoice} ariaLabel="Send this invoice" success="Send queued for approval">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Button type="submit" className="max-sm:w-full">
                  Send…
                </Button>
              </ActionForm>
            ) : null}
            {/* The same document the client reads in their portal, so an
                invoice can be saved as a PDF for a client who never signs in. */}
            <Button asChild variant="secondary">
              <Link href={`/invoices/${invoice.id}/print`}>Print</Link>
            </Button>
          </>
        }
      />

      {sendFailure ? (
        <InlineAlert
          tone="danger"
          title={`Send failed: ${sendFailure.message}${sendFailure.to ? ` (to ${sendFailure.to})` : ""}`}
          className="mb-4"
          action={
            sendable ? (
              <ActionForm
                action={requestSendInvoice}
                ariaLabel="Request another send of this invoice"
                success="Send queued for approval"
              >
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Button type="submit" variant="secondary" size="sm">
                  Request send again
                </Button>
              </ActionForm>
            ) : null
          }
        >
          The invoice is marked sent so it cannot go out twice, and the approval that authorised it is spent.
        </InlineAlert>
      ) : null}

      {pendingSend ? (
        <InlineAlert tone="warning" className="mb-4">
          This invoice is awaiting approval before it is emailed.{" "}
          <Link href="/approvals" className="underline">
            Open approvals
          </Link>
          .
        </InlineAlert>
      ) : (
        <p className="mb-4 text-meta text-muted-foreground">
          Sending emails the client a link to their portal invoice and needs approval first.
        </p>
      )}

      <Section>
        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <KeyValue items={details} columns={2} className="sm:grid-cols-2 lg:grid-cols-4" />
          {settled ? null : (
            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t pt-4">
              <ActionForm action={markInvoiceAsPaid} ariaLabel="Mark this invoice paid" success="Invoice marked paid">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Button type="submit" variant="secondary" size="sm">
                  Mark paid
                </Button>
              </ActionForm>
              <ActionForm action={voidInvoiceAction} ariaLabel="Void this invoice" success="Invoice voided">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Button type="submit" variant="destructive" size="sm">
                  Void
                </Button>
              </ActionForm>
            </div>
          )}
        </div>
      </Section>

      <Section title="Line items">
        <DataList
          rows={invoice.lineItems}
          columns={lineColumns(invoice.currency)}
          getRowKey={(line, index) => `${line.description}-${index}`}
          caption="Invoice line items"
          empty={<EmptyState>This invoice has no line items.</EmptyState>}
        />
      </Section>

      <Section title="Payments">
        <DataList<PaymentRow>
          rows={payments}
          columns={PAYMENT_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Payments against this invoice"
          empty={<EmptyState icon={Banknote}>No payments recorded against this invoice.</EmptyState>}
        />
      </Section>
    </>
  );
}
