import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";

export interface RevenueMonth {
  /** `2026-09`, so a caller can key on it without parsing a label. */
  readonly month: string;
  /** "Sep" — for the axis. */
  readonly label: string;
  readonly pence: number;
}

/**
 * Money actually collected, by calendar month.
 *
 * **Paid invoices only, keyed on `paid_at`.** Not issued, not sent, not
 * outstanding — the chart answers "what came in", and an invoice raised in
 * August but settled in September is September's money. Anything else produces
 * a revenue line that disagrees with the bank.
 *
 * Grouped in `Europe/London` rather than UTC: an invoice paid at 00:30 on the
 * first of the month in British Summer Time is that month's, and grouping in
 * UTC would quietly file it under the previous one.
 */
export async function revenueByMonth(db: Db, organisationId: string, months = 6, now: Date = new Date()): Promise<RevenueMonth[]> {
  // The first day of the window, in London terms, so a part-month at the start
  // is not silently dropped.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const rows = await db
    .select({
      month: sql<string>`to_char(${schema.invoices.paidAt} at time zone 'Europe/London', 'YYYY-MM')`.as("month"),
      pence: sql<string>`coalesce(sum(${schema.invoices.totalPence}), 0)`.as("pence"),
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.status, "paid"),
        isNotNull(schema.invoices.paidAt),
        gte(schema.invoices.paidAt, start),
      ),
    )
    .groupBy(sql`1`);

  const found = new Map(rows.map((r) => [r.month, Number(r.pence)]));

  // Every month in the window is emitted whether or not it has revenue. A gap
  // in a bar chart reads as "no data"; a zero reads as "no money", and only one
  // of those is true.
  return Array.from({ length: months }, (_, i) => {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1));
    const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
      month,
      label: at.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
      pence: found.get(month) ?? 0,
    };
  });
}
