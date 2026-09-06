import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { toCheckoutSession, type PaymentsWebhookEvent } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
import { recordAudit } from "../audit/record-audit.js";
import { completeSignup, SIGNUP_MARKER, SignupRefused } from "../signup/signup.js";
import { reconcileInvoice } from "./payments.js";

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

const StripeCheckoutObject = z.object({
  id: z.string(),
  status: z.string().nullish(),
  payment_status: z.string().nullish(),
  customer: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  subscription: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  customer_email: z.string().nullish(),
  customer_details: z.object({ email: z.string().nullish() }).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<SyncResult> {
  const object = (event.data as { object?: unknown }).object;

  // A self-serve signup paid through Checkout. The route resolved tenancy
  // from our metadata (`signupOrganisationFromEvent`); `completeSignup`
  // checks it again and is idempotent by session, so a redelivery is a
  // `signup.duplicate`, never a second client.
  if (event.type === "checkout.session.completed") {
    const parsed = StripeCheckoutObject.safeParse(object);
    if (!parsed.success) return { handled: false, action: "unparseable" };
    if (parsed.data.metadata?.["launchos"] !== SIGNUP_MARKER) return { handled: false, action: "ignored" };
    const session = toCheckoutSession(parsed.data as unknown as Parameters<typeof toCheckoutSession>[0]);
    try {
      const result = await completeSignup(db, organisationId, { session }, {}, env);
      return { handled: true, action: result.alreadyCompleted ? "signup.duplicate" : "signup.completed" };
    } catch (error) {
      if (error instanceof SignupRefused) return { handled: false, action: `signup.${error.reason}` };
      throw error;
    }
  }

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const parsed = StripeInvoiceObject.safeParse(object);
    if (!parsed.success) return { handled: false, action: "unparseable" };
    const [invoice] = await db.select().from(schema.invoices).where(and(
      eq(schema.invoices.organisationId, organisationId),
      eq(schema.invoices.stripeInvoiceId, parsed.data.id),
    ));
    if (!invoice) return { handled: false, action: "unknown_invoice" };

    const succeeded = event.type === "invoice.paid";
    // Known assumption: when Stripe omits the amount we take the invoice total,
    // so a partial capture that arrives without `amount_paid` settles the
    // invoice in full. Accepted while every invoice here is paid in one go —
    // revisit the moment partial captures are switched on.
    const amountPence = (succeeded ? parsed.data.amount_paid : parsed.data.amount_due) ?? invoice.totalPence;
    const currency = parsed.data.currency.toUpperCase();

    return db.transaction(async (tx) => {
      const inner = tx as unknown as Db;
      // The provider retries webhooks. The unique (organisation_id, provider,
      // provider_ref) index is the single authority on "already processed":
      // the insert either claims this event id or, on conflict, inserts
      // nothing. A separate SELECT-then-INSERT check leaves a race window
      // where two near-simultaneous deliveries of the same event can both
      // pass the check; this does not, because the conflict is resolved by
      // Postgres inside the insert itself.
      //
      // Known assumption: the key is the *event* id, not the underlying charge.
      // Two distinct Stripe events describing the same charge would each insert
      // a payment row. Accepted for the one-event-per-payment flows in use;
      // dedup on the charge id if that ever stops holding.
      const [payment] = await tx.insert(schema.payments).values({
        organisationId,
        clientId: invoice.clientId,
        invoiceId: invoice.id,
        amountPence,
        currency,
        provider: "stripe",
        providerRef: event.id,
        status: succeeded ? "succeeded" : "failed",
        paidAt: succeeded ? new Date() : null,
      })
        .onConflictDoNothing({
          target: [schema.payments.organisationId, schema.payments.provider, schema.payments.providerRef],
        })
        .returning();
      if (!payment) return { handled: false, action: "duplicate" };

      await recordAudit(inner, organisationId, {
        actorKind: "system", action: "payment.recorded", targetType: "payment", targetId: payment.id, after: payment,
      });

      if (!succeeded) {
        await notifyOwner(inner, organisationId, {
          kind: "payment.failed",
          title: `Payment failed for invoice ${invoice.number}`,
          body: `Stripe reported a failed payment of £${(invoice.totalPence / 100).toFixed(2)}.`,
          link: `/invoices/${invoice.id}`,
        });
        return { handled: true, action: "payment.failed" };
      }

      // The action reports what actually happened to the invoice, not what the
      // event was called: a payment against a draft or a void invoice is a
      // recorded payment and an open anomaly, never an `invoice.paid`.
      const reconciled = await reconcileInvoice(inner, organisationId, invoice.id);
      if (reconciled.settled) return { handled: true, action: "invoice.paid" };
      if (reconciled.reason === "underpaid") return { handled: true, action: "payment.recorded" };
      return { handled: true, action: "invoice.settle_skipped" };
    });
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
