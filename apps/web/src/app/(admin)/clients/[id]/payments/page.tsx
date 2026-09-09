import { clientCostByCurrency, getClient, getClientMoney } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq, inArray } from "drizzle-orm";
import { Banknote, CreditCard, ExternalLink, Receipt, Wallet } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { RecordPaymentDialog } from "../../../payments/record-payment-dialog";
import { PAYMENT_PROVIDERS } from "../../../payments/schemas";
import { RaiseInvoiceButton } from "../billing/raise-invoice-button";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * One client's money on one screen.
 *
 * Invoices had a tab, subscriptions sat in a strip on the overview, and
 * payments existed only in the organisation-wide list you had to filter down.
 * So the question anybody actually asks about a client — *are they paying us,
 * and do they owe us anything* — took three screens and mental arithmetic.
 *
 * This answers it in the first three figures, puts the history under them, and
 * places the two actions somebody reaches for at the moment they decide to
 * take one: record a payment that arrived by bank or cash, and raise the next
 * invoice.
 */

type PaymentRow = Awaited<ReturnType<typeof getClientMoney>>["payments"][number];

const COLUMNS: readonly DataListColumn<PaymentRow>[] = [
  {
    key: "amount",
    header: "Amount",
    primary: true,
    numeric: true,
    cell: (row) => formatPence(row.amountPence, row.currency),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: "paidAt",
    header: "Paid",
    className: "whitespace-nowrap",
    // A pending entry has no date. "Not settled" says why the row is there at
    // all, where an em dash would read as missing data.
    cell: (row) => (row.paidAt ? formatDate(row.paidAt) : <span className="text-muted-foreground">Not settled</span>),
  },
  { key: "provider", header: "Via", cell: (row) => row.provider },
  {
    key: "invoice",
    header: "Invoice",
    cell: (row) =>
      row.invoiceId && row.invoiceNumber ? (
        <Link href={`/invoices/${row.invoiceId}`} className="hover:underline">
          {row.invoiceNumber}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: "ref",
    header: "Reference",
    cell: (row) => (row.providerRef ? <span className="font-mono text-meta">{row.providerRef}</span> : "—"),
  },
];

/** Adding two currencies together would be a lie, so each is printed on its own. */
function money(totals: Record<string, number>): string {
  const entries = Object.entries(totals).filter(([, value]) => value !== 0);
  if (entries.length === 0) return formatPence(0, "GBP");
  return entries.map(([currency, value]) => formatPence(value, currency)).join(" · ");
}

export default async function ClientPaymentsPage({ params }: PageProps<"/clients/[id]/payments">) {
  const id = uuidOr404((await params).id);
  const session = await requireAdmin();
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const [summary, costs] = await Promise.all([
    getClientMoney(db, session.organisationId, { clientId: id }),
    clientCostByCurrency(db, session.organisationId, id),
  ]);

  // Only invoices that can still take a payment, so the dialog cannot be
  // pointed at one that is already settled.
  const openInvoices = await db
    .select({ id: schema.invoices.id, number: schema.invoices.number, clientId: schema.invoices.clientId })
    .from(schema.invoices)
    .where(and(
      eq(schema.invoices.organisationId, session.organisationId),
      eq(schema.invoices.clientId, id),
      inArray(schema.invoices.status, ["sent", "overdue"]),
    ));

  const live = summary.subscriptions.filter((row) => row.status === "active" || row.status === "trialing");
  const monthly = live.reduce<Record<string, number>>((acc, row) => {
    acc[row.currency] = (acc[row.currency] ?? 0) + row.amountPence;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title={client.name}
        description="What they have paid, what they owe, and what is charged next."
        category="money"
        actions={
          <div className="flex flex-wrap gap-2">
            <RecordPaymentDialog
              clients={[{ value: client.id, label: client.name }]}
              invoices={openInvoices.map((row) => ({ value: row.id, label: row.number, clientId: row.clientId }))}
              providers={PAYMENT_PROVIDERS}
            />
            <RaiseInvoiceButton clientId={client.id} />
          </div>
        }
      />

      <ClientTabs clientId={client.id} active="payments" />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Paid to date"
          value={money(summary.paidPence)}
          hint={
            Object.keys(summary.refundedPence).length > 0
              ? `${money(summary.refundedPence)} refunded`
              : "Settled payments only"
          }
          category="money"
          icon={Banknote}
        />
        <StatCard
          label="Outstanding"
          value={money(summary.outstandingPence)}
          hint={summary.overdueCount > 0 ? `${summary.overdueCount} overdue` : "Nothing overdue"}
          href={`/clients/${client.id}/invoices`}
          // Turns amber-side when money is late: the one figure here that
          // should stop somebody scrolling past.
          category={summary.overdueCount > 0 ? "support" : "money"}
          icon={Receipt}
        />
        <StatCard
          label="Charged monthly"
          value={money(monthly)}
          hint={live.length === 0 ? "No live subscription" : `${live.length} live`}
          category="money"
          icon={CreditCard}
        />
      </div>

      {/* The other half of the ledger. Kept as its own row rather than netted
          into the figures above, because the costs are in the supplier's
          currency and a margin printed across two currencies would be a
          number that looks precise and is not. */}
      {Object.keys(costs).length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Costs us, per renewal"
            value={money(costs)}
            hint="What we pay suppliers for this client"
            href="/settings/costs"
            category="money"
            icon={Wallet}
          />
        </div>
      ) : null}

      {summary.subscriptions.length > 0 ? (
        <Section title="Subscriptions" description="What recurs, and when it next takes payment." className="mt-8">
          <div className="rounded-[20px] border bg-card p-5">
            <ul className="min-w-0 divide-y">
              {summary.subscriptions.map((row) => (
                <li
                  key={row.id}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
                >
                  <span className="min-w-0 flex-1 font-medium">{row.packageName ?? "Subscription"}</span>
                  <StatusBadge value={row.status} />
                  <span className="tabular-nums">{formatPence(row.amountPence, row.currency)}/mo</span>
                  <span className="text-meta whitespace-nowrap text-muted-foreground">
                    {row.currentPeriodEnd ? `next ${formatDate(row.currentPeriodEnd)}` : "no date"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      <Section
        title="Payment history"
        description="Every payment recorded against this client, newest first."
        className="mt-8"
        actions={
          summary.stripeCustomerId ? (
            <Button asChild variant="secondary" size="sm">
              <a
                href={`https://dashboard.stripe.com/customers/${summary.stripeCustomerId}`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Stripe
                <ExternalLink aria-hidden strokeWidth={1.75} className="size-4" />
              </a>
            </Button>
          ) : null
        }
      >
        <DataList
          rows={summary.payments}
          columns={COLUMNS}
          getRowKey={(row) => row.id}
          caption="Payments"
          empty={
            <EmptyState icon={Banknote}>
              Nothing recorded yet. Card payments file themselves once Stripe reports them; anything that arrived by
              bank transfer or cash is recorded from the button above.
            </EmptyState>
          }
        />
      </Section>
    </>
  );
}
