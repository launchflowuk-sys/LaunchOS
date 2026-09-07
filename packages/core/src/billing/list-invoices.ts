import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq, sum } from "drizzle-orm";
import { z } from "zod";

export const ListInvoicesInput = z.object({
  status: z.enum(schema.invoiceStatusEnum.enumValues).optional(),
  clientId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListInvoicesInput = z.input<typeof ListInvoicesInput>;

export interface InvoiceListRow {
  readonly id: string;
  /** Every invoice has one — the column is NOT NULL, including for drafts. */
  readonly number: string;
  readonly status: "draft" | "sent" | "paid" | "overdue" | "void";
  readonly clientId: string;
  readonly clientName: string;
  readonly issuedAt: Date;
  readonly dueAt: Date;
  /**
   * Pence, as everywhere else in LaunchOS. Money is never a float here — a
   * reader wanting pounds divides by 100 and knows it did so.
   */
  readonly totalPence: number;
  readonly currency: string;
  /** Whole days past due. Null unless it is actually overdue. */
  readonly overdueDays: number | null;
}

export interface ListInvoicesResult {
  readonly invoices: InvoiceListRow[];
  readonly total: number;
  /**
   * The sum over **every** invoice matching the filter, not just this page.
   *
   * Without it the only way to answer "how much am I owed" is to page through
   * everything and add up — which an assistant will do wrong, silently, the
   * first time there are more invoices than one page holds.
   */
  readonly totalPenceMatching: number;
}

/**
 * Invoices, with the client's name already on them.
 *
 * `void` invoices are included when asked for and never excluded silently: an
 * invoice that was voided is a fact about the month, and a total that quietly
 * drops rows is a total nobody can reconcile.
 */
export async function listInvoices(
  db: Db,
  organisationId: string,
  input: ListInvoicesInput = {},
  now: Date = new Date(),
): Promise<ListInvoicesResult> {
  const v = ListInvoicesInput.parse(input);
  const where = and(
    eq(schema.invoices.organisationId, organisationId),
    v.status ? eq(schema.invoices.status, v.status) : undefined,
    v.clientId ? eq(schema.invoices.clientId, v.clientId) : undefined,
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        status: schema.invoices.status,
        clientId: schema.invoices.clientId,
        clientName: schema.clients.name,
        issuedAt: schema.invoices.issuedAt,
        dueAt: schema.invoices.dueAt,
        totalPence: schema.invoices.totalPence,
        currency: schema.invoices.currency,
      })
      .from(schema.invoices)
      .innerJoin(schema.clients, eq(schema.invoices.clientId, schema.clients.id))
      .where(where)
      .orderBy(desc(schema.invoices.issuedAt), desc(schema.invoices.id))
      .limit(v.limit)
      .offset(v.offset),
    db
      .select({ value: count(), pence: sum(schema.invoices.totalPence) })
      .from(schema.invoices)
      .where(where),
  ]);

  return {
    invoices: rows.map((row) => ({
      ...row,
      // Only when the invoice is actually overdue. A paid invoice whose due
      // date has passed is not late, and reporting it as late is how a client
      // gets chased for money they already sent.
      overdueDays:
        row.status === "overdue"
          ? Math.max(0, Math.floor((now.getTime() - row.dueAt.getTime()) / 86_400_000))
          : null,
    })),
    total: totals?.value ?? 0,
    // Postgres `sum()` comes back as a numeric string, and as null over no
    // rows at all — both become a number here so a caller never adds a string
    // to a number and gets "0123".
    totalPenceMatching: Number(totals?.pence ?? 0),
  };
}
