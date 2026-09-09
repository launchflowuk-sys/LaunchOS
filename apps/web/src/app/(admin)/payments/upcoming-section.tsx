import { listUpcomingPayments, totalUpcomingByCurrency } from "@launchos/core";
import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

type Row = Awaited<ReturnType<typeof listUpcomingPayments>>[number];

/** "in 3 days", "today", "4 days ago" — the phrasing you actually think in. */
function whenLabel(daysUntil: number): string {
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  if (daysUntil > 1) return `in ${daysUntil} days`;
  if (daysUntil === -1) return "yesterday";
  return `${Math.abs(daysUntil)} days ago`;
}

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "client",
    header: "Client",
    cell: (row) => (
      <Link href={`/clients/${row.clientId}`} className="font-medium text-primary hover:underline">
        {row.clientName}
      </Link>
    ),
  },
  { key: "package", header: "Package", cell: (row) => row.packageName ?? "Monthly retainer" },
  {
    key: "due",
    header: "Due",
    cell: (row) => (
      <span className="tabular-nums">
        {formatDate(row.dueAt)}
        {/* A date on its own makes you count. The phrase does it for you, and
            an overdue one is the row worth reading first. */}
        <span className={row.daysUntil < 0 ? "ml-2 font-medium text-danger-fg" : "ml-2 text-muted-foreground"}>
          {whenLabel(row.daysUntil)}
        </span>
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    cell: (row) => (
      <span className="font-medium tabular-nums">{formatPence(row.amountPence, row.currency)}</span>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
];

/**
 * What is coming, as opposed to what has arrived.
 *
 * Read from each active subscription's `currentPeriodEnd` — the date the
 * provider charges it again — rather than from a schedule table, so it cannot
 * drift from the date Stripe actually bills on.
 */
export async function UpcomingPaymentsSection() {
  const session = await requireAdmin();
  const rows = await listUpcomingPayments(getDb(), session.organisationId, { days: 60 });
  const totals = totalUpcomingByCurrency(rows);

  return (
    <Section
      title="Coming up"
      description="Subscription charges due in the next 60 days, from each subscription's current period."
      actions={
        rows.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-3">
            {Object.entries(totals).map(([currency, pence]) => (
              <span key={currency} className="text-figure font-semibold tabular-nums">
                {formatPence(pence, currency)}
              </span>
            ))}
            <span className="text-meta text-muted-foreground">expected</span>
          </div>
        ) : null
      }
    >
      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.subscriptionId}
        caption="Upcoming subscription payments"
        empty={
          <EmptyState icon={CalendarClock}>
            No subscription charges due in the next 60 days.
          </EmptyState>
        }
      />
    </Section>
  );
}
