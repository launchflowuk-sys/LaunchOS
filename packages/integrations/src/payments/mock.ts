import {
  PAYMENT_TERMS_DEFAULT_DAYS, addDays, addMonths, vatOf,
  type CreateCustomerInput, type CreateSubscriptionInput, type PaymentsAdapter,
  type PaymentsCustomer, type PaymentsInvoice, type PaymentsSubscription, type PaymentsWebhookEvent,
} from "./types.js";

export interface MockPaymentsOptions {
  vatRatePercent?: number;
  termsDays?: number;
}

/**
 * In-memory Stripe stand-in. Ids are prefixed `mock_` so a mock id can never be
 * mistaken for a real Stripe id in the database or in a log line.
 */
export class MockPaymentsAdapter implements PaymentsAdapter {
  readonly name = "mock" as const;

  private seq = 0;
  private readonly customers = new Map<string, PaymentsCustomer>();
  private readonly subscriptions = new Map<string, PaymentsSubscription>();
  private readonly invoices = new Map<string, PaymentsInvoice>();
  private readonly vatRatePercent: number;
  private readonly termsDays: number;

  constructor(options: MockPaymentsOptions = {}) {
    this.vatRatePercent = options.vatRatePercent ?? 20;
    this.termsDays = options.termsDays ?? PAYMENT_TERMS_DEFAULT_DAYS;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `mock_${prefix}_${this.seq}`;
  }

  async createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer> {
    const customer: PaymentsCustomer = {
      id: this.id("cus"),
      name: input.name,
      ...(input.email !== undefined ? { email: input.email } : {}),
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async createSubscription(input: CreateSubscriptionInput) {
    const subscription: PaymentsSubscription = {
      id: this.id("sub"),
      customerId: input.customerId,
      status: "active",
      currentPeriodStart: input.periodStart,
      currentPeriodEnd: addMonths(input.periodStart, 1),
      amountPence: input.amountPence,
      currency: input.currency,
    };
    this.subscriptions.set(subscription.id, subscription);
    return { subscription, invoice: this.issueInvoice(subscription) };
  }

  async cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription> {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) throw new Error(`mock payments: unknown subscription ${subscriptionId}`);
    const cancelled: PaymentsSubscription = { ...existing, status: "cancelled" };
    this.subscriptions.set(subscriptionId, cancelled);
    return cancelled;
  }

  async listInvoices(customerId: string): Promise<PaymentsInvoice[]> {
    return [...this.invoices.values()].filter((i) => i.customerId === customerId);
  }

  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent {
    if (signature !== "mock") throw new Error("mock payments: invalid webhook signature");
    const parsed = JSON.parse(rawBody) as Partial<PaymentsWebhookEvent>;
    if (!parsed.id || !parsed.type) throw new Error("mock payments: webhook body needs id and type");
    return { id: parsed.id, type: parsed.type, data: parsed.data ?? {} };
  }

  /** Test affordance: bills the next period and returns the new invoice. */
  advancePeriod(subscriptionId: string): PaymentsInvoice {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) throw new Error(`mock payments: unknown subscription ${subscriptionId}`);
    const rolled: PaymentsSubscription = {
      ...existing,
      currentPeriodStart: existing.currentPeriodEnd,
      currentPeriodEnd: addMonths(existing.currentPeriodEnd, 1),
    };
    this.subscriptions.set(subscriptionId, rolled);
    return this.issueInvoice(rolled);
  }

  private issueInvoice(subscription: PaymentsSubscription): PaymentsInvoice {
    const vatPence = vatOf(subscription.amountPence, this.vatRatePercent);
    const invoice: PaymentsInvoice = {
      id: this.id("in"),
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      status: "sent",
      issuedAt: subscription.currentPeriodStart,
      dueAt: addDays(subscription.currentPeriodStart, this.termsDays),
      subtotalPence: subscription.amountPence,
      vatPence,
      totalPence: subscription.amountPence + vatPence,
      currency: subscription.currency,
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }
}
