import { listClients } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { CreditCard } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { RecordPaymentDialog } from "./record-payment-dialog";
import { PAYMENT_PROVIDERS } from "./schemas";

export const dynamic = "force-dynamic";

/** An invoice can still take money until it is settled or written off. */
const UNPAID = ["draft", "sent", "overdue"] as const;

type PaymentRow = {
  id: string;
  amountPence: number;
  currency: string;
  provider: string;
  providerRef: string | null;
  status: string;
  paidAt: Date | null;
  createdAt: Date;
  clientId: string;
  clientName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
};

const COLUMNS: readonly DataListColumn<PaymentRow>[] = [
  {
    key: "client",
    header: "Client",
    primary: true,
    cell: (row) => (
      <Link href={`/clients/${row.clientId}`} className="hover:underline">
        {row.clientName}
      </Link>
    ),
  },
  {
    key: "date",
    header: "Date",
    cell: (row) => <span className="whitespace-nowrap">{formatDateTime(row.paidAt ?? row.createdAt)}</span>,
  },
  {
    key: "invoice",
    header: "Invoice",
    cell: (row) =>
      row.invoiceId ? (
        <Link href={`/invoices/${row.invoiceId}`} className="hover:underline">
          {row.invoiceNumber}
        </Link>
      ) : (
        "—"
      ),
  },
  {
    key: "amount",
    header: "Amount",
    numeric: true,
    className: "font-medium text-foreground",
    cell: (row) => formatPence(row.amountPence, row.currency),
  },
  { key: "provider", header: "Provider", cell: (row) => row.provider },
  { key: "reference", header: "Reference", hideOnMobile: true, cell: (row) => row.providerRef ?? "—" },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
];

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
        clientId: schema.invoices.clientId,
      })
      // No join: the dialog groups these under the client the user picks, so
      // the client's name is never rendered against an invoice option.
      .from(schema.invoices)
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
        category="money"
        actions={
          <RecordPaymentDialog
            clients={clients.map((c) => ({ value: c.id, label: c.name }))}
            invoices={openInvoices.map((i) => ({
              value: i.id,
              clientId: i.clientId,
              label: `${i.number} — ${formatPence(i.totalPence, i.currency)}`,
            }))}
            providers={PAYMENT_PROVIDERS}
          />
        }
      />

      <DataList<PaymentRow>
        rows={payments}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Payments"
        empty={
          <EmptyState icon={CreditCard}>
            No payments recorded yet. Record one above once money lands.
          </EmptyState>
        }
      />
    </>
  );
}
