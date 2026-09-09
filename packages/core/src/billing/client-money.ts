import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * One client's money, in one read.
 *
 * The pieces already existed and were scattered across three screens: invoices
 * on their own tab, subscriptions in a strip on the overview, payments only in
 * the organisation-wide list where you had to filter to find one client's. So
 * the question anybody actually asks about a client — *are they paying us, and
 * do they owe us anything* — could not be answered without visiting three
 * places and doing arithmetic.
 *
 * The totals below are deliberately computed in SQL rather than by summing in
 * TypeScript: a client with two years of monthly invoices is a lot of rows to
 * pull across just to add them up, and the page needs the figure far more
 * often than it needs the rows.
 */

export const ClientMoneyInput = z.object({
  clientId: z.string().uuid(),
  /** How many payments and invoices to bring back for the history. */
  limit: z.number().int().min(1).max(200).default(50),
});
export type ClientMoneyInput = z.input<typeof ClientMoneyInput>;

export interface ClientPaymentRow {
  id: string;
  amountPence: number;
  currency: string;
  provider: string;
  providerRef: string | null;
  status: string;
  paidAt: Date | null;
  createdAt: Date;
  invoiceId: string | null;
  invoiceNumber: string | null;
}

export interface ClientMoney {
  payments: ClientPaymentRow[];
  /** Settled money in, by currency. Refunds and failures excluded. */
  paidPence: Record<string, number>;
  /** Refunded, by currency — shown beside the total rather than netted into it. */
  refundedPence: Record<string, number>;
  /** Invoiced and not yet settled, by currency. */
  outstandingPence: Record<string, number>;
  /** How many of those are past their due date. */
  overdueCount: number;
  /** Whether Stripe knows this client, and as whom. */
  stripeCustomerId: string | null;
  subscriptions: {
    id: string;
    status: string;
    amountPence: number;
    currency: string;
    packageName: string | null;
    currentPeriodEnd: Date | null;
    /** How the money arrives — anything but `stripe` is work somebody does each month. */
    collectionMethod: string;
    billingNotes: string | null;
  }[];
}

/** Statuses that mean an invoice is still owed. */
const OWED = ["sent", "overdue"] as const;

function byCurrency(rows: readonly { currency: string; total: number | string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.currency] = Number(row.total ?? 0);
  return out;
}

export async function getClientMoney(
  db: Db,
  organisationId: string,
  input: ClientMoneyInput,
): Promise<ClientMoney> {
  const v = ClientMoneyInput.parse(input);
  const owned = and(
    eq(schema.payments.organisationId, organisationId),
    eq(schema.payments.clientId, v.clientId),
  );

  const [payments, paid, refunded, outstanding, overdue, account, subscriptions] = await Promise.all([
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
        invoiceId: schema.payments.invoiceId,
        invoiceNumber: schema.invoices.number,
      })
      .from(schema.payments)
      .leftJoin(schema.invoices, eq(schema.payments.invoiceId, schema.invoices.id))
      .where(owned)
      // `paid_at` is null on a pending entry, so the fallback keeps those at
      // the top where somebody can see they have not settled.
      .orderBy(desc(sql`coalesce(${schema.payments.paidAt}, ${schema.payments.createdAt})`))
      .limit(v.limit),
    db
      .select({ currency: schema.payments.currency, total: sql<number>`sum(${schema.payments.amountPence})` })
      .from(schema.payments)
      .where(and(owned, eq(schema.payments.status, "succeeded")))
      .groupBy(schema.payments.currency),
    db
      .select({ currency: schema.payments.currency, total: sql<number>`sum(${schema.payments.amountPence})` })
      .from(schema.payments)
      .where(and(owned, eq(schema.payments.status, "refunded")))
      .groupBy(schema.payments.currency),
    db
      .select({ currency: schema.invoices.currency, total: sql<number>`sum(${schema.invoices.totalPence})` })
      .from(schema.invoices)
      .where(and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.clientId, v.clientId),
        inArray(schema.invoices.status, [...OWED]),
      ))
      .groupBy(schema.invoices.currency),
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.invoices)
      .where(and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.clientId, v.clientId),
        eq(schema.invoices.status, "overdue"),
      )),
    db
      .select({ customerId: schema.clientPaymentAccounts.externalCustomerId })
      .from(schema.clientPaymentAccounts)
      .where(and(
        eq(schema.clientPaymentAccounts.organisationId, organisationId),
        eq(schema.clientPaymentAccounts.clientId, v.clientId),
      ))
      .limit(1),
    db
      .select({
        id: schema.subscriptions.id,
        status: schema.subscriptions.status,
        amountPence: schema.subscriptions.amountPence,
        currency: schema.subscriptions.currency,
        packageName: schema.packages.name,
        currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
        collectionMethod: schema.subscriptions.collectionMethod,
        billingNotes: schema.subscriptions.billingNotes,
      })
      .from(schema.subscriptions)
      .leftJoin(schema.packages, eq(schema.subscriptions.packageId, schema.packages.id))
      .where(and(
        eq(schema.subscriptions.organisationId, organisationId),
        eq(schema.subscriptions.clientId, v.clientId),
      ))
      .orderBy(desc(schema.subscriptions.createdAt)),
  ]);

  return {
    payments,
    paidPence: byCurrency(paid),
    refundedPence: byCurrency(refunded),
    outstandingPence: byCurrency(outstanding),
    overdueCount: Number(overdue[0]?.n ?? 0),
    stripeCustomerId: account[0]?.customerId ?? null,
    subscriptions,
  };
}
