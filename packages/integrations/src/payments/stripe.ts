import Stripe from "stripe";
import {
  addDays, type CreateCheckoutSessionInput, type CreateCustomerInput, type CreateSubscriptionInput, type PaymentsAdapter,
  type PaymentsCheckoutSession, type PaymentsCheckoutStatus, type PaymentsCustomer, type PaymentsInvoice,
  type PaymentsInvoiceStatus, type PaymentsSubscription, type PaymentsSubscriptionStatus, type PaymentsWebhookEvent,
} from "./types.js";

export interface StripePaymentsOptions {
  secretKey: string;
  webhookSecret: string;
  termsDays?: number;
}

const SUBSCRIPTION_STATUS: Record<string, PaymentsSubscriptionStatus> = {
  trialing: "trialing", active: "active", past_due: "past_due", unpaid: "past_due",
  canceled: "cancelled", incomplete_expired: "cancelled", paused: "paused", incomplete: "paused",
};

const INVOICE_STATUS: Record<string, PaymentsInvoiceStatus> = {
  draft: "draft", open: "sent", paid: "paid", uncollectible: "overdue", void: "void",
};

export class StripePaymentsAdapter implements PaymentsAdapter {
  readonly name = "stripe" as const;

  private readonly client: Stripe;
  private readonly webhookSecret: string;
  private readonly termsDays: number;

  constructor(options: StripePaymentsOptions) {
    this.client = new Stripe(options.secretKey);
    this.webhookSecret = options.webhookSecret;
    this.termsDays = options.termsDays ?? 14;
  }

  async createCustomer(input: CreateCustomerInput): Promise<PaymentsCustomer> {
    const customer = await this.client.customers.create({
      name: input.name,
      ...(input.email !== undefined ? { email: input.email } : {}),
      metadata: { clientRef: input.clientRef },
    });
    return {
      id: customer.id,
      name: customer.name ?? input.name,
      ...(customer.email ? { email: customer.email } : {}),
    };
  }

  async createSubscription(input: CreateSubscriptionInput) {
    // The installed Stripe SDK's subscription-item `price_data` no longer accepts an
    // inline `product_data` — a Price (and its ad-hoc Product) must be created first.
    const price = await this.client.prices.create({
      currency: input.currency.toLowerCase(),
      product_data: { name: input.description },
      recurring: { interval: "month" },
      unit_amount: input.amountPence,
    });
    const subscription = await this.client.subscriptions.create({
      customer: input.customerId,
      collection_method: "send_invoice",
      days_until_due: this.termsDays,
      items: [{ price: price.id }],
      expand: ["latest_invoice"],
    });
    const latest = subscription.latest_invoice;
    if (!latest || typeof latest === "string") {
      throw new Error("stripe: subscription created without an expanded latest_invoice");
    }
    return { subscription: this.toSubscription(subscription), invoice: this.toInvoice(latest) };
  }

  async cancelSubscription(subscriptionId: string): Promise<PaymentsSubscription> {
    return this.toSubscription(await this.client.subscriptions.cancel(subscriptionId));
  }

  async listInvoices(customerId: string): Promise<PaymentsInvoice[]> {
    const page = await this.client.invoices.list({ customer: customerId, limit: 100 });
    return page.data.map((invoice) => this.toInvoice(invoice));
  }

  webhookVerify(rawBody: string, signature: string): PaymentsWebhookEvent {
    const event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return { id: event.id, type: event.type, data: event.data as unknown as Record<string, unknown> };
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<PaymentsCheckoutSession> {
    const session = await this.client.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: input.priceId, quantity: 1 }],
      customer_email: input.customerEmail,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReference,
      metadata: input.metadata,
      // The same metadata on the subscription itself, so a support lookup in
      // the Stripe dashboard finds the LaunchOS client from either object.
      subscription_data: { metadata: input.metadata },
    });
    return toCheckoutSession(session);
  }

  async retrieveCheckoutSession(sessionId: string): Promise<PaymentsCheckoutSession> {
    return toCheckoutSession(await this.client.checkout.sessions.retrieve(sessionId));
  }

  private toSubscription(s: Stripe.Subscription): PaymentsSubscription {
    const item = s.items.data[0];
    return {
      id: s.id,
      customerId: typeof s.customer === "string" ? s.customer : s.customer.id,
      status: SUBSCRIPTION_STATUS[s.status] ?? "paused",
      currentPeriodStart: new Date((item?.current_period_start ?? s.start_date) * 1000),
      currentPeriodEnd: new Date((item?.current_period_end ?? s.start_date) * 1000),
      amountPence: item?.price.unit_amount ?? 0,
      currency: (item?.price.currency ?? "gbp").toUpperCase(),
    };
  }

  private toInvoice(i: Stripe.Invoice): PaymentsInvoice {
    const issuedAt = new Date((i.created ?? 0) * 1000);
    const subscriptionId = typeof i.parent?.subscription_details?.subscription === "string"
      ? i.parent.subscription_details.subscription
      : undefined;
    return {
      id: i.id ?? "",
      customerId: typeof i.customer === "string" ? i.customer : (i.customer?.id ?? ""),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      status: INVOICE_STATUS[i.status ?? "draft"] ?? "draft",
      issuedAt,
      dueAt: i.due_date ? new Date(i.due_date * 1000) : addDays(issuedAt, this.termsDays),
      subtotalPence: i.subtotal ?? 0,
      vatPence: i.total_taxes?.reduce((sum, t) => sum + t.amount, 0) ?? 0,
      totalPence: i.total ?? 0,
      currency: (i.currency ?? "gbp").toUpperCase(),
      ...(i.hosted_invoice_url ? { hostedUrl: i.hosted_invoice_url } : {}),
      ...(i.invoice_pdf ? { pdfUrl: i.invoice_pdf } : {}),
    };
  }
}

const CHECKOUT_STATUS: Record<string, PaymentsCheckoutStatus> = { open: "open", complete: "complete", expired: "expired" };
const CHECKOUT_PAYMENT_STATUS: Record<string, PaymentsCheckoutSession["paymentStatus"]> = {
  paid: "paid", unpaid: "unpaid", no_payment_required: "no_payment_required",
};

function idOf(ref: string | { id: string } | null | undefined): string | undefined {
  if (!ref) return undefined;
  return typeof ref === "string" ? ref : ref.id;
}

/**
 * The shape a `checkout.session.completed` webhook object has as well, so
 * core's `syncFromPaymentsEvent` reads the event through this same mapping.
 */
export function toCheckoutSession(s: Stripe.Checkout.Session): PaymentsCheckoutSession {
  const customerId = idOf(s.customer);
  const subscriptionId = idOf(s.subscription);
  const customerEmail = s.customer_details?.email ?? s.customer_email ?? undefined;
  return {
    id: s.id,
    status: CHECKOUT_STATUS[s.status ?? "open"] ?? "open",
    paymentStatus: CHECKOUT_PAYMENT_STATUS[s.payment_status ?? "unpaid"] ?? "unpaid",
    ...(s.url ? { url: s.url } : {}),
    ...(customerId !== undefined ? { customerId } : {}),
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    ...(customerEmail ? { customerEmail } : {}),
    metadata: Object.fromEntries(Object.entries(s.metadata ?? {}).map(([k, v]) => [k, String(v)])),
  };
}
