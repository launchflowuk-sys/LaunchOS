import { randomUUID } from "node:crypto";
import {
  PAYMENT_TERMS_DEFAULT_DAYS, addDays, addMonths, vatOf,
  type CreateCheckoutSessionInput, type CreateCustomerInput, type CreateSubscriptionInput, type PaymentsAdapter,
  type PaymentsCheckoutSession, type PaymentsCustomer, type PaymentsInvoice, type PaymentsSubscription,
  type PaymentsSubscriptionStatus, type PaymentsWebhookEvent,
} from "./types.js";

export interface MockPaymentsOptions {
  vatRatePercent?: number;
  termsDays?: number;
}

/**
 * In-memory Stripe stand-in. Ids are prefixed `mock_` so a mock id can never be
 * mistaken for a real Stripe id in the database or in a log line.
 *
 * The map is a cache, not the record of what exists — the database is. A mock
 * that refuses to act on state it lost is not a usable stand-in for a durable
 * provider: `next dev` re-evaluates modules on every edit, and a redeploy
 * restarts the process, either of which would otherwise leave a subscription
 * written days ago permanently uncancellable. So every read path synthesises a
 * plausible record for an id it has never seen, and ids are UUID-based rather
 * than counter-based so a restart can never re-issue one that is already in the
 * database under `subscriptions_org_stripe_id`.
 */
export class MockPaymentsAdapter implements PaymentsAdapter {
  readonly name = "mock" as const;

  private readonly customers = new Map<string, PaymentsCustomer>();
  private readonly subscriptions = new Map<string, PaymentsSubscription>();
  private readonly invoices = new Map<string, PaymentsInvoice>();
  private readonly checkouts = new Map<string, PaymentsCheckoutSession>();
  private readonly vatRatePercent: number;
  private readonly termsDays: number;

  constructor(options: MockPaymentsOptions = {}) {
    this.vatRatePercent = options.vatRatePercent ?? 20;
    this.termsDays = options.termsDays ?? PAYMENT_TERMS_DEFAULT_DAYS;
  }

  private id(prefix: string): string {
    return `mock_${prefix}_${randomUUID()}`;
  }

  /** Whether this id could have been issued by a mock adapter at all. */
  private static isMockId(prefix: string, id: string): boolean {
    return id.startsWith(`mock_${prefix}_`);
  }

  /**
   * The subscription this adapter would have issued for `id`, whether or not it
   * still remembers issuing it. A never-seen id is reconstructed rather than
   * rejected — see the class comment.
   */
  private recall(subscriptionId: string, status: PaymentsSubscriptionStatus): PaymentsSubscription {
    const existing = this.subscriptions.get(subscriptionId);
    if (existing) return { ...existing, status };
    if (!MockPaymentsAdapter.isMockId("sub", subscriptionId)) {
      throw new Error(`mock payments: ${subscriptionId} is not a mock subscription id`);
    }
    const now = new Date();
    return {
      id: subscriptionId,
      customerId: this.id("cus"),
      status,
      currentPeriodStart: now,
      currentPeriodEnd: addMonths(now, 1),
      amountPence: 0,
      currency: "GBP",
    };
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
    const cancelled = this.recall(subscriptionId, "cancelled");
    this.subscriptions.set(subscriptionId, cancelled);
    return cancelled;
  }

  /**
   * Reads a subscription back. Not on `PaymentsAdapter` — nothing in core needs
   * it yet — but it is the other half of `cancelSubscription`'s tolerance, and
   * tests use it to assert that a restart is survivable.
   */
  async getSubscription(subscriptionId: string): Promise<PaymentsSubscription> {
    const existing = this.subscriptions.get(subscriptionId);
    return existing ?? this.recall(subscriptionId, "active");
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

  /**
   * A "hosted page" that is really the success URL with the session id filled
   * in, so a local signup lands on `/signup/done` exactly as a real one would.
   * The session is `open` until `completeCheckout` (below) or a retrieve of an
   * id this process has never seen, which — like `recall` — is reconstructed
   * as complete rather than refused, so a dev-server restart cannot strand a
   * signup half-way.
   */
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<PaymentsCheckoutSession> {
    const id = this.id("cs");
    const session: PaymentsCheckoutSession = {
      id,
      status: "open",
      paymentStatus: "unpaid",
      url: input.successUrl.replace("{CHECKOUT_SESSION_ID}", id),
      customerEmail: input.customerEmail,
      metadata: { ...input.metadata, priceId: input.priceId, clientReference: input.clientReference },
    };
    this.checkouts.set(id, session);
    return session;
  }

  /**
   * Retrieving a session is the buyer coming back from the "hosted page", so
   * an open session is completed on the way out: `/signup/done` then sees a
   * paid session exactly as it would from Stripe. An id this process never
   * saw is reconstructed as complete for the same reason `recall` tolerates
   * unknown subscription ids.
   */
  async retrieveCheckoutSession(sessionId: string): Promise<PaymentsCheckoutSession> {
    const existing = this.checkouts.get(sessionId);
    if (existing && existing.status !== "open") return existing;
    if (!existing && !MockPaymentsAdapter.isMockId("cs", sessionId)) {
      throw new Error(`mock payments: ${sessionId} is not a mock checkout session id`);
    }
    return this.completeCheckout(sessionId);
  }

  /**
   * Test affordance, and what a mock signup's `/signup/done` relies on: marks
   * the session paid with a customer and a subscription behind it, the way
   * Stripe's `checkout.session.completed` would report it.
   */
  completeCheckout(sessionId: string, overrides: Partial<PaymentsCheckoutSession> = {}): PaymentsCheckoutSession {
    const existing = this.checkouts.get(sessionId);
    const completed: PaymentsCheckoutSession = {
      id: sessionId,
      status: "complete",
      paymentStatus: "paid",
      customerId: existing?.customerId ?? this.id("cus"),
      subscriptionId: existing?.subscriptionId ?? this.id("sub"),
      ...(existing?.customerEmail !== undefined ? { customerEmail: existing.customerEmail } : {}),
      metadata: existing?.metadata ?? {},
      ...overrides,
    };
    this.checkouts.set(sessionId, completed);
    return completed;
  }

  /** Test affordance: bills the next period and returns the new invoice. */
  advancePeriod(subscriptionId: string): PaymentsInvoice {
    const existing = this.recall(subscriptionId, "active");
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
