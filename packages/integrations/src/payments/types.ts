export type PaymentsSubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "paused";
export type PaymentsInvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export interface PaymentsCustomer {
  id: string;
  name: string;
  email?: string;
}

export interface PaymentsSubscription {
  id: string;
  customerId: string;
  status: PaymentsSubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  amountPence: number;
  currency: string;
}

export interface PaymentsInvoice {
  id: string;
  customerId: string;
  subscriptionId?: string;
  status: PaymentsInvoiceStatus;
  issuedAt: Date;
  dueAt: Date;
  subtotalPence: number;
  vatPence: number;
  totalPence: number;
  currency: string;
  hostedUrl?: string;
  pdfUrl?: string;
}

/** A provider webhook, normalised to the two fields the worker branches on. */
export interface PaymentsWebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface CreateCustomerInput {
  name: string;
  email?: string;
  /** The client's slug — carried to the provider as metadata for support lookups. */
  clientRef: string;
}

export interface CreateSubscriptionInput {
  customerId: string;
  amountPence: number;
  currency: string;
  description: string;
  periodStart: Date;
}

/**
 * A hosted Checkout page for a self-serve signup. `metadata` is echoed back on
 * the session (and on the `checkout.session.completed` webhook), which is how
 * `completeSignup` knows which organisation and package the buyer chose.
 */
/**
 * A charge with no catalogue price behind it — a proposal's setup fee, or a
 * one-off piece of work quoted on the day. The figure comes from the accepted
 * proposal's lines, so no Stripe Price could exist for it in advance.
 */
export interface CheckoutOneOffLine {
  amountPence: number;
  /** ISO code; lower-cased for the provider. */
  currency: string;
  /** What the buyer sees on the Checkout page and the receipt. */
  description: string;
}

export interface CreateCheckoutSessionInput {
  /**
   * The provider price id — `packages.stripe_price_id`. Present for anything
   * that recurs; absent for a purely one-off session, which is then opened in
   * payment mode rather than subscription mode.
   */
  priceId?: string;
  /**
   * Added to the *same* session as `priceId`, which is the whole point: a
   * setup fee plus a retainer is one Checkout the client completes once, and
   * Stripe puts the one-off on the subscription's first invoice. Two sessions
   * would mean two payments, and a client who paid one and abandoned the other.
   */
  oneOff?: CheckoutOneOffLine;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** A short reference shown in the provider dashboard (the lead id, say). */
  clientReference: string;
  metadata: Record<string, string>;
}

export type PaymentsCheckoutStatus = "open" | "complete" | "expired";

export interface PaymentsCheckoutSession {
  id: string;
  status: PaymentsCheckoutStatus;
  /** `paid` once the first payment settled; `unpaid` while open or for a failed card. */
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  /** The hosted page to send the buyer to. Absent once the session is no longer open. */
  url?: string;
  customerId?: string;
  subscriptionId?: string;
  customerEmail?: string;
  metadata: Record<string, string>;
}

export type PaymentsBillingInterval = "day" | "week" | "month" | "year";

/**
 * One active recurring Price with the Product it sells — a row of the Stripe
 * catalogue as Settings → Billing → Stripe reviews it. One-off prices and
 * anything whose ids are not Stripe-shaped (`price_…` / `prod_…`; a WordPress
 * plugin has been seen writing `fluentform_…` pseudo prices) are left out.
 */
export interface PaymentsCatalogItem {
  priceId: string;
  productId: string;
  productName: string;
  productActive: boolean;
  amountPence: number;
  currency: string;
  interval: PaymentsBillingInterval;
  intervalCount: number;
}

/**
 * A provider subscription with everything the sync needs to file it: who
 * pays (customer id, email, name), what for (price and product), and where
 * it is in its life. `status` is our vocabulary; `providerStatus` is the
 * provider's own word, kept for the review screen and the audit trail.
 */
export interface PaymentsSubscriptionDetail {
  id: string;
  status: PaymentsSubscriptionStatus;
  providerStatus: string;
  customerId: string;
  customerEmail?: string;
  customerName?: string;
  priceId: string;
  productId: string;
  amountPence: number;
  currency: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAt?: Date;
  canceledAt?: Date;
  createdAt: Date;
}

/**
 * Stripe's subscription statuses in our five-word vocabulary. One table for
 * the adapter, the catalogue sync and the webhook, so a nightly reconcile and
 * a `customer.subscription.updated` can never disagree about the same row.
 *
 * `unpaid` and the two `incomplete` states are cancelled here: Stripe has
 * stopped (or never started) collecting, and a retainer nobody is paying for
 * must not read as merely late.
 */
export const PROVIDER_SUBSCRIPTION_STATUS: Readonly<Record<string, PaymentsSubscriptionStatus>> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  paused: "paused",
  canceled: "cancelled",
  unpaid: "cancelled",
  incomplete: "cancelled",
  incomplete_expired: "cancelled",
};

/** Unknown provider words are `paused`: the safe reading for a status we have never seen. */
export function subscriptionStatusFromProvider(providerStatus: string): PaymentsSubscriptionStatus {
  return PROVIDER_SUBSCRIPTION_STATUS[providerStatus] ?? "paused";
}

/** True for a Stripe-issued id of the given object family (`price_…`, `prod_…`, `cus_…`, `sub_…`). */
export function isProviderId(prefix: "price" | "prod" | "cus" | "sub", id: string | null | undefined): id is string {
  return typeof id === "string" && id.startsWith(`${prefix}_`);
}

export interface PaymentsAdapter {
  readonly name: "mock" | "stripe";
  createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer>;
  /** One customer by provider id; throws for an id the provider does not know or has deleted. */
  retrieveCustomer(customerId: string): Promise<PaymentsCustomer>;
  /** Every active recurring price with its product, across all pages. */
  listCatalog(): Promise<PaymentsCatalogItem[]>;
  /** Every subscription in every status, across all pages. */
  listSubscriptions(): Promise<PaymentsSubscriptionDetail[]>;
  createSubscription(input: CreateSubscriptionInput): Promise<{ subscription: PaymentsSubscription; invoice: PaymentsInvoice }>;
  cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription>;
  listInvoices(customerId: string): Promise<PaymentsInvoice[]>;
  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<PaymentsCheckoutSession>;
  retrieveCheckoutSession(sessionId: string): Promise<PaymentsCheckoutSession>;
}

export const PAYMENT_TERMS_DEFAULT_DAYS = 14;

export function addMonths(from: Date, months: number): Date {
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export function vatOf(subtotalPence: number, vatRatePercent: number): number {
  return Math.round((subtotalPence * vatRatePercent) / 100);
}
