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
export interface CreateCheckoutSessionInput {
  /** The provider price id — `packages.stripe_price_id`. */
  priceId: string;
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

export interface PaymentsAdapter {
  readonly name: "mock" | "stripe";
  createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer>;
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
