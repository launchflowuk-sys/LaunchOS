import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import {
  isProviderId, subscriptionStatusFromProvider, toCheckoutSession,
  type PaymentsAdapter, type PaymentsSubscriptionDetail, type PaymentsWebhookEvent,
} from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
import { recordAudit } from "../audit/record-audit.js";
import { completeSignup, SIGNUP_MARKER, SignupRefused } from "../signup/signup.js";
import { findClientByStripeCustomer } from "./payment-accounts.js";
import { reconcileInvoice } from "./payments.js";
import { STRIPE_CLIENT_CREATED_NOTIFICATION_KIND, STRIPE_STATUS_CHANGED_NOTIFICATION_KIND, importStripeSubscription } from "./stripe-sync.js";

const StripeInvoiceObject = z.object({
  id: z.string(),
  customer: z.string(),
  amount_paid: z.number().int().optional(),
  amount_due: z.number().int().optional(),
  currency: z.string().default("gbp"),
});

const UnixSeconds = z.number().int();
const StripePriceRef = z.object({
  id: z.string(),
  product: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  unit_amount: z.number().int().nullish(),
  currency: z.string().nullish(),
});
const StripeSubscriptionObject = z.object({
  id: z.string(),
  customer: z.union([z.string(), z.object({ id: z.string() })]),
  status: z.string(),
  created: UnixSeconds.optional(),
  start_date: UnixSeconds.nullish(),
  current_period_start: UnixSeconds.nullish(),
  current_period_end: UnixSeconds.nullish(),
  cancel_at: UnixSeconds.nullish(),
  canceled_at: UnixSeconds.nullish(),
  items: z.object({
    data: z.array(z.object({
      quantity: z.number().int().nullish(),
      current_period_start: UnixSeconds.nullish(),
      current_period_end: UnixSeconds.nullish(),
      price: StripePriceRef,
    })),
  }).optional(),
});
type StripeSubscriptionObject = z.infer<typeof StripeSubscriptionObject>;

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

/** The webhook's subscription object in the shape `listSubscriptions` returns, or null when it names no Stripe-shaped price. */
function subscriptionDetailFromEvent(
  object: StripeSubscriptionObject,
  status: PaymentsSubscriptionDetail["status"],
  customer: { email?: string | undefined; name?: string | undefined },
): PaymentsSubscriptionDetail | null {
  const item = object.items?.data[0];
  const priceId = item?.price.id;
  const productRef = item?.price.product;
  const productId = typeof productRef === "string" ? productRef : productRef?.id;
  if (!isProviderId("price", priceId) || !isProviderId("prod", productId)) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const seconds = (field: "current_period_start" | "current_period_end") =>
    item?.[field] ?? object[field] ?? object.start_date ?? object.created ?? nowSeconds;
  return {
    id: object.id,
    status,
    providerStatus: object.status,
    customerId: typeof object.customer === "string" ? object.customer : object.customer.id,
    ...(customer.email ? { customerEmail: customer.email } : {}),
    ...(customer.name ? { customerName: customer.name } : {}),
    priceId,
    productId,
    amountPence: (item?.price.unit_amount ?? 0) * (item?.quantity ?? 1),
    currency: (item?.price.currency ?? "gbp").toUpperCase(),
    currentPeriodStart: new Date(seconds("current_period_start") * 1000),
    currentPeriodEnd: new Date(seconds("current_period_end") * 1000),
    ...(object.cancel_at ? { cancelAt: new Date(object.cancel_at * 1000) } : {}),
    ...(object.canceled_at ? { canceledAt: new Date(object.canceled_at * 1000) } : {}),
    createdAt: new Date((object.created ?? object.start_date ?? nowSeconds) * 1000),
  };
}

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

export interface SyncResult {
  handled: boolean;
  action: string;
}

/**
 * A Stripe webhook arrives with no tenancy of its own. The customer id on the
 * event is the only link back to a LaunchOS organisation, so it is resolved
 * through `client_payment_accounts` (then `billing_profiles.stripe_customer_id`
 * for a profile older code linked) before anything is written.
 */
export async function findOrganisationByStripeCustomer(
  db: Db,
  stripeCustomerId: string,
): Promise<{ organisationId: string; clientId: string } | undefined> {
  return findClientByStripeCustomer(db, stripeCustomerId);
}

export interface SyncDeps {
  /**
   * For a subscription event from a customer LaunchOS has never seen: the
   * adapter fetches the customer's email and name so the client it provisions
   * is matched by email and named after the business, not after a `cus_` id.
   * Without it the client is still created, from the id alone.
   */
  payments?: PaymentsAdapter | undefined;
}

export async function syncFromPaymentsEvent(
  db: Db,
  organisationId: string,
  event: PaymentsWebhookEvent,
  env: NodeJS.ProcessEnv = process.env,
  deps: SyncDeps = {},
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

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const parsed = StripeSubscriptionObject.safeParse(object);
    if (!parsed.success) return { handled: false, action: "unparseable" };
    return syncSubscriptionEvent(db, organisationId, event.type, parsed.data, env, deps);
  }

  return { handled: false, action: "ignored" };
}

/**
 * A subscription LaunchOS already holds takes its status (and, when the
 * event carries them, its price, period and amount) from the event. One it
 * has never seen is provisioned — client, billing profile, subscription —
 * when its product is linked to a package, and the owner is told there is a
 * new client. An unlinked product is reported, not imported: linking is the
 * owner's decision on Settings → Billing → Stripe.
 */
async function syncSubscriptionEvent(
  db: Db,
  organisationId: string,
  eventType: string,
  object: StripeSubscriptionObject,
  env: NodeJS.ProcessEnv,
  deps: SyncDeps,
): Promise<SyncResult> {
  const status = eventType === "customer.subscription.deleted" ? "cancelled" : subscriptionStatusFromProvider(object.status);
  const known = await db.select({ id: schema.subscriptions.id }).from(schema.subscriptions).where(and(
    eq(schema.subscriptions.organisationId, organisationId),
    eq(schema.subscriptions.stripeSubscriptionId, object.id),
  ));
  const detail = subscriptionDetailFromEvent(object, status, {});

  if (known.length > 0) {
    // The status alone when the event carries no usable price (a hand-made
    // test event, say); everything the event knows otherwise.
    const imported = detail ? await importStripeSubscription(db, organisationId, detail, { actorKind: "system" }, env) : null;
    if (!imported) {
      await db.update(schema.subscriptions).set({ status, updatedAt: new Date() })
        .where(eq(schema.subscriptions.id, known[0]!.id));
    } else if (imported.statusChange) {
      await notifyOwner(db, organisationId, {
        kind: STRIPE_STATUS_CHANGED_NOTIFICATION_KIND,
        title: `${imported.clientName}: subscription ${imported.statusChange.to.replace("_", " ")}`,
        body: `Stripe reported ${object.id} as ${object.status} (was ${imported.statusChange.from.replace("_", " ")}).`,
        link: `/clients/${imported.clientId}/billing`,
      });
    }
    return { handled: true, action: `subscription.${status}` };
  }

  if (!detail) return { handled: false, action: "subscription.unmapped_price" };
  const customer = await customerDetails(deps.payments, detail.customerId);
  const imported = await importStripeSubscription(db, organisationId, { ...detail, ...customer }, { actorKind: "system" }, env);
  if (!imported) {
    console.debug(
      { organisationId, subscriptionId: object.id, priceId: detail.priceId, productId: detail.productId },
      "stripe subscription on a product no package is linked to; not imported",
    );
    return { handled: false, action: "subscription.unmapped_price" };
  }
  if (imported.clientCreated) {
    await notifyOwner(db, organisationId, {
      kind: STRIPE_CLIENT_CREATED_NOTIFICATION_KIND,
      title: `New client from Stripe: ${imported.clientName}`,
      body: `Stripe subscription ${object.id} (${object.status}) was filed under a new client. Check the name and add a portal login.`,
      link: `/clients/${imported.clientId}`,
    });
  }
  return { handled: true, action: "subscription.provisioned" };
}

/** The customer's email and name from the provider, or nothing when there is no adapter or the lookup fails. */
async function customerDetails(
  payments: PaymentsAdapter | undefined,
  customerId: string,
): Promise<{ customerEmail?: string; customerName?: string }> {
  if (!payments) return {};
  try {
    const customer = await payments.retrieveCustomer(customerId);
    return {
      ...(customer.email ? { customerEmail: customer.email } : {}),
      ...(customer.name ? { customerName: customer.name } : {}),
    };
  } catch (error) {
    console.warn(
      { customerId, error: error instanceof Error ? error.message : String(error) },
      "stripe customer lookup failed; provisioning from the id alone",
    );
    return {};
  }
}
