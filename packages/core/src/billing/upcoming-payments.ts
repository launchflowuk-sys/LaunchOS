import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";

/**
 * What is due, and when.
 *
 * The product could always answer "what have they paid" — the payments table
 * is a record of money that has already arrived. It could not answer "what is
 * coming", which is the question you ask before you commit to a cost.
 *
 * There is no schedule table and there does not need to be: an active
 * subscription already carries `currentPeriodEnd`, which is the date Stripe
 * will charge it again. This reads those dates rather than storing a second
 * copy that could drift from the one Stripe actually bills on.
 *
 * Frequency is deliberately not modelled. Every subscription here is monthly —
 * `createSubscription` says so in the description it sends Stripe — and Shoji
 * asked to leave frequency out. When a non-monthly plan exists, the interval
 * has to be stored on the subscription first; guessing it from two dates would
 * be a lie the moment a period is prorated.
 */
export const ListUpcomingPaymentsInput = z.object({
  /** How far ahead to look. */
  days: z.number().int().min(1).max(365).default(60),
  clientId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type ListUpcomingPaymentsInput = z.input<typeof ListUpcomingPaymentsInput>;

export type UpcomingPayment = {
  subscriptionId: string;
  clientId: string;
  clientName: string;
  packageName: string | null;
  amountPence: number;
  currency: string;
  /** The date the current period ends, which is the date it is charged again. */
  dueAt: Date;
  status: string;
  /** Negative when the date has passed and no payment has been recorded since. */
  daysUntil: number;
};

/** The statuses that still mean money is expected. */
const EXPECTED = ["active", "past_due", "trialing"] as const;

export async function listUpcomingPayments(
  db: Db,
  organisationId: string,
  input: ListUpcomingPaymentsInput = {},
): Promise<UpcomingPayment[]> {
  const v = ListUpcomingPaymentsInput.parse(input);
  const now = new Date();
  const horizon = new Date(now.getTime() + v.days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      subscriptionId: schema.subscriptions.id,
      clientId: schema.subscriptions.clientId,
      clientName: schema.clients.name,
      packageName: schema.packages.name,
      amountPence: schema.subscriptions.amountPence,
      currency: schema.subscriptions.currency,
      dueAt: schema.subscriptions.currentPeriodEnd,
      status: schema.subscriptions.status,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.clients, eq(schema.subscriptions.clientId, schema.clients.id))
    .leftJoin(schema.packages, eq(schema.subscriptions.packageId, schema.packages.id))
    .where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      inArray(schema.subscriptions.status, [...EXPECTED]),
      isNull(schema.subscriptions.deletedAt),
      // Everything up to the horizon, including dates already gone by: a
      // period end in the past with the subscription still active means a
      // charge that has not been reconciled, and hiding it would hide the one
      // row worth looking at.
      lte(schema.subscriptions.currentPeriodEnd, horizon),
      ...(v.clientId ? [eq(schema.subscriptions.clientId, v.clientId)] : []),
    ))
    .orderBy(asc(schema.subscriptions.currentPeriodEnd))
    .limit(v.limit);

  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = startOfDay(now);

  return rows.map((row) => ({
    ...row,
    // Whole days, so "due today" is 0 rather than a fraction either side of it.
    daysUntil: Math.round((startOfDay(row.dueAt) - today) / (24 * 60 * 60 * 1000)),
  }));
}

/** What the next `days` of subscriptions add up to, by currency. */
export function totalUpcomingByCurrency(rows: readonly UpcomingPayment[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((totals, row) => ({
    ...totals,
    [row.currency]: (totals[row.currency] ?? 0) + row.amountPence,
  }), {});
}
