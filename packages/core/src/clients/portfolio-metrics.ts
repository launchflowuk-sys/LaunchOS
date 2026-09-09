import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, inArray, sql } from "drizzle-orm";

/** Money is being collected under these; the rest are not revenue today. */
const EARNING = ["trialing", "active", "past_due"] as const;
/** Work that is still in flight. */
const IN_FLIGHT = ["planned", "active", "on_hold"] as const;

export interface PortfolioMetrics {
  readonly activeClients: number;
  readonly onboarding: number;
  /** Everything currently billed on a recurring basis, in pence per month. */
  readonly recurringPence: number;
  readonly projectsInFlight: number;
  /** Every pound that actually arrived. The honest version of "lifetime value". */
  readonly lifetimePence: number;
}

/**
 * The four numbers that describe the client book.
 *
 * All four come from rows we already hold. That matters more than it sounds:
 * the obvious fifth number on a dashboard like this is "client satisfaction",
 * and there is nothing in the database that measures it — a score with no
 * source is a number that will eventually be quoted at a client, so it is not
 * here and should not be added until something actually asks them.
 *
 * `recurringPence` counts `past_due` alongside `active`, because a subscription
 * that has missed a payment is still a subscription and still what the client
 * is on. Cancelled and paused are excluded: those are not revenue this month.
 *
 * `lifetimePence` is money received, and it has to read two tables to say so.
 * It used to sum invoices marked `paid`, which described a business that
 * collects through Stripe and nothing else. Most clients here pay an invoice by
 * bank transfer; the transfer gets recorded as a `payment` and the invoice is
 * never touched again, so a real book of business read **£0.00** on screen
 * while the Payments tab showed the money. Now: every succeeded payment, plus
 * paid invoices that have no succeeded payment against them — which keeps the
 * years of history that predate payment rows without counting the settled ones
 * twice.
 */
export async function clientPortfolioMetrics(db: Db, organisationId: string): Promise<PortfolioMetrics> {
  const [active, onboarding, recurring, projects, received, settledWithoutPayment] = await Promise.all([
    db
      .select({ value: count() })
      .from(schema.clients)
      .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.status, "active"))),
    db
      .select({ value: count() })
      .from(schema.clients)
      .where(
        and(
          eq(schema.clients.organisationId, organisationId),
          eq(schema.clients.status, "active"),
          sql`${schema.clients.packageId} is not null and ${schema.clients.onboardedAt} is null`,
        ),
      ),
    db
      .select({ pence: sql<string>`coalesce(sum(${schema.subscriptions.amountPence}), 0)` })
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.organisationId, organisationId),
          inArray(schema.subscriptions.status, [...EARNING]),
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.projects)
      .where(and(eq(schema.projects.organisationId, organisationId), inArray(schema.projects.status, [...IN_FLIGHT]))),
    db
      .select({ pence: sql<string>`coalesce(sum(${schema.payments.amountPence}), 0)` })
      .from(schema.payments)
      .where(and(eq(schema.payments.organisationId, organisationId), eq(schema.payments.status, "succeeded"))),
    db
      .select({ pence: sql<string>`coalesce(sum(${schema.invoices.totalPence}), 0)` })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.organisationId, organisationId),
          eq(schema.invoices.status, "paid"),
          sql`not exists (
            select 1 from ${schema.payments}
            where ${schema.payments.invoiceId} = ${schema.invoices.id}
              and ${schema.payments.status} = 'succeeded'
          )`,
        ),
      ),
  ]);

  return {
    activeClients: active[0]?.value ?? 0,
    onboarding: onboarding[0]?.value ?? 0,
    // Postgres `sum()` comes back as a numeric string; unconverted it turns
    // addition into concatenation further up.
    recurringPence: Number(recurring[0]?.pence ?? 0),
    projectsInFlight: projects[0]?.value ?? 0,
    lifetimePence: Number(received[0]?.pence ?? 0) + Number(settledWithoutPayment[0]?.pence ?? 0),
  };
}
