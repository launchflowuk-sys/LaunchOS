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

export interface PaymentsAdapter {
  readonly name: "mock" | "stripe";
  createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer>;
  createSubscription(input: CreateSubscriptionInput): Promise<{ subscription: PaymentsSubscription; invoice: PaymentsInvoice }>;
  cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription>;
  listInvoices(customerId: string): Promise<PaymentsInvoice[]>;
  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent;
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
