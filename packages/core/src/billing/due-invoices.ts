import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { invoiceDatesFor, isDueToRaise, type InvoiceDates } from "./invoice-dates.js";

/**
 * Which retainers are owed an invoice today.
 *
 * Nothing raised them. Invoices came from signup, or from somebody pressing
 * "Raise invoice" on a client screen — which means a client billed by transfer
 * got an invoice when Shoji remembered, and the date it carried was whatever
 * day that happened to be. That is how an invoice came to be issued on the 5th
 * for money that was already a month late.
 *
 * A retainer is due when its notice date has arrived and no invoice for that
 * period exists yet. Stripe is excluded entirely: it collects on its own and
 * an invoice raised here would be a duplicate of something already happening.
 */

/** Money is being collected under these; the rest are not billed. */
const BILLABLE = ["trialing", "active", "past_due"] as const;

export interface DueInvoice {
  subscriptionId: string;
  clientId: string;
  clientName: string;
  amountPence: number;
  currency: string;
  collectionMethod: string;
  dates: InvoiceDates;
}

/**
 * Idempotence is on `(subscription, dueAt)` rather than a period key, because
 * the due date **is** the period as far as billing is concerned: a subscription
 * whose period start moves gets a different due date and therefore a different
 * invoice, which is correct. Re-running this sweep an hour later, or after a
 * restart, raises nothing twice.
 */
export async function subscriptionsDueToInvoice(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<DueInvoice[]> {
  const rows = await db
    .select({
      subscriptionId: schema.subscriptions.id,
      clientId: schema.subscriptions.clientId,
      clientName: schema.clients.name,
      amountPence: schema.subscriptions.amountPence,
      currency: schema.subscriptions.currency,
      collectionMethod: schema.subscriptions.collectionMethod,
      currentPeriodStart: schema.subscriptions.currentPeriodStart,
      noticeDays: schema.billingProfiles.paymentTermsDays,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.clients, eq(schema.subscriptions.clientId, schema.clients.id))
    .leftJoin(
      schema.billingProfiles,
      and(
        eq(schema.billingProfiles.clientId, schema.subscriptions.clientId),
        eq(schema.billingProfiles.organisationId, organisationId),
      ),
    )
    .where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      inArray(schema.subscriptions.status, [...BILLABLE]),
      isNull(schema.subscriptions.deletedAt),
      eq(schema.clients.status, "active"),
      isNull(schema.clients.deletedAt),
    ));

  const due: DueInvoice[] = [];

  for (const row of rows) {
    // Stripe bills itself. Raising one here would be a second demand for money
    // already being taken.
    if (row.collectionMethod === "stripe") continue;

    const dates = invoiceDatesFor({
      periodStart: row.currentPeriodStart,
      collectionMethod: row.collectionMethod,
      noticeDays: row.noticeDays ?? undefined,
    });
    if (!isDueToRaise(dates, now)) continue;

    const [existing] = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.subscriptionId, row.subscriptionId),
        eq(schema.invoices.dueAt, dates.dueAt),
        isNull(schema.invoices.deletedAt),
      ));
    if (existing) continue;

    due.push({
      subscriptionId: row.subscriptionId,
      clientId: row.clientId,
      clientName: row.clientName,
      amountPence: row.amountPence,
      currency: row.currency,
      collectionMethod: row.collectionMethod,
      dates,
    });
  }

  return due;
}
