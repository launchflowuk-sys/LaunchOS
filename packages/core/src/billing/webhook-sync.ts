import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsWebhookEvent } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
import { recordPayment } from "./payments.js";

type LocalSubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "paused";

const StripeInvoiceObject = z.object({
  id: z.string(),
  customer: z.string(),
  amount_paid: z.number().int().optional(),
  amount_due: z.number().int().optional(),
  currency: z.string().default("gbp"),
});

const StripeSubscriptionObject = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
});

const STRIPE_TO_LOCAL_STATUS: Record<string, LocalSubscriptionStatus> = {
  trialing: "trialing", active: "active", past_due: "past_due", unpaid: "past_due",
  canceled: "cancelled", incomplete_expired: "cancelled", paused: "paused", incomplete: "paused",
};

export interface SyncResult {
  handled: boolean;
  action: string;
}

/**
 * A Stripe webhook arrives with no tenancy of its own. The customer id on the
 * event is the only link back to a LaunchOS organisation, so it is resolved
 * through `billing_profiles.stripe_customer_id` before anything is written.
 */
export async function findOrganisationByStripeCustomer(
  db: Db,
  stripeCustomerId: string,
): Promise<{ organisationId: string; clientId: string } | undefined> {
  const [row] = await db
    .select({ organisationId: schema.billingProfiles.organisationId, clientId: schema.billingProfiles.clientId })
    .from(schema.billingProfiles)
    .where(eq(schema.billingProfiles.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row;
}

export async function syncFromPaymentsEvent(
  db: Db,
  organisationId: string,
  event: PaymentsWebhookEvent,
): Promise<SyncResult> {
  // The provider retries webhooks; the unique (organisation_id, provider,
  // provider_ref) index plus this pre-check make replays a no-op.
  const [seen] = await db.select({ id: schema.payments.id }).from(schema.payments).where(and(
    eq(schema.payments.organisationId, organisationId),
    eq(schema.payments.providerRef, event.id),
  ));
  if (seen) return { handled: false, action: "duplicate" };

  const object = (event.data as { object?: unknown }).object;

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const parsed = StripeInvoiceObject.safeParse(object);
    if (!parsed.success) return { handled: false, action: "unparseable" };
    const [invoice] = await db.select().from(schema.invoices).where(and(
      eq(schema.invoices.organisationId, organisationId),
      eq(schema.invoices.stripeInvoiceId, parsed.data.id),
    ));
    if (!invoice) return { handled: false, action: "unknown_invoice" };

    const succeeded = event.type === "invoice.paid";
    await recordPayment(db, organisationId, {
      clientId: invoice.clientId,
      invoiceId: invoice.id,
      amountPence: (succeeded ? parsed.data.amount_paid : parsed.data.amount_due) ?? invoice.totalPence,
      currency: parsed.data.currency.toUpperCase(),
      provider: "stripe",
      providerRef: event.id,
      status: succeeded ? "succeeded" : "failed",
      actorKind: "system",
    });

    if (!succeeded) {
      await notifyOwner(db, organisationId, {
        kind: "payment.failed",
        title: `Payment failed for invoice ${invoice.number}`,
        body: `Stripe reported a failed payment of £${(invoice.totalPence / 100).toFixed(2)}.`,
        link: `/invoices/${invoice.id}`,
      });
      return { handled: true, action: "payment.failed" };
    }
    return { handled: true, action: "invoice.paid" };
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const parsed = StripeSubscriptionObject.safeParse(object);
    if (!parsed.success) return { handled: false, action: "unparseable" };
    const status = event.type === "customer.subscription.deleted"
      ? "cancelled"
      : (STRIPE_TO_LOCAL_STATUS[parsed.data.status] ?? "paused");
    const updated = await db.update(schema.subscriptions)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(schema.subscriptions.organisationId, organisationId),
        eq(schema.subscriptions.stripeSubscriptionId, parsed.data.id),
      ))
      .returning({ id: schema.subscriptions.id });
    if (updated.length === 0) return { handled: false, action: "unknown_subscription" };
    return { handled: true, action: `subscription.${status}` };
  }

  return { handled: false, action: "ignored" };
}
