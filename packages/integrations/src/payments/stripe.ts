import Stripe from "stripe";
import {
  addDays, isProviderId, subscriptionStatusFromProvider,
  type CreateCheckoutSessionInput, type CreateCustomerInput, type CreateSubscriptionInput, type PaymentsAdapter,
  type PaymentsBillingInterval, type PaymentsCatalogItem, type PaymentsCheckoutSession, type PaymentsCheckoutStatus,
  type PaymentsCustomer, type PaymentsInvoice, type PaymentsInvoiceStatus, type PaymentsSubscription,
  type PaymentsSubscriptionDetail, type PaymentsWebhookEvent,
} from "./types.js";

export interface StripePaymentsOptions {
  secretKey: string;
  webhookSecret: string;
  termsDays?: number;
}

/** Stripe's page size ceiling; every list here walks pages until `has_more` is false. */
const PAGE_SIZE = 100;

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

  async retrieveCustomer(customerId: string): Promise<PaymentsCustomer> {
    const customer = await this.client.customers.retrieve(customerId);
    if (customer.deleted) throw new Error(`stripe: customer ${customerId} has been deleted`);
    return toCustomer(customer);
  }

  /**
   * Active recurring prices with their products, every page. The product is
   * expanded on the price so the walk is one request per hundred prices,
   * not one per product.
   */
  async listCatalog(): Promise<PaymentsCatalogItem[]> {
    const prices = await paginate((startingAfter) => this.client.prices.list({
      active: true, type: "recurring", limit: PAGE_SIZE, expand: ["data.product"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }));
    return prices.flatMap((price) => {
      const item = toCatalogItem(price);
      return item ? [item] : [];
    });
  }

  /**
   * Every subscription in every status, every page, with the customer
   * expanded so the sync can match by email without a request per customer.
   */
  async listSubscriptions(): Promise<PaymentsSubscriptionDetail[]> {
    const subscriptions = await paginate((startingAfter) => this.client.subscriptions.list({
      status: "all", limit: PAGE_SIZE, expand: ["data.customer"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }));
    return subscriptions.flatMap((s) => {
      const detail = toSubscriptionDetail(s);
      return detail ? [detail] : [];
    });
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

  /**
   * One session, whatever shape the money is.
   *
   * A recurring price makes it a subscription; a one-off line rides on the
   * same session and Stripe bills it on the first invoice, which is how a
   * proposal's "setup fee plus monthly" becomes a single thing to pay. With
   * no recurring price at all it is a payment-mode session for the one-off
   * alone. The metadata is copied onto whichever object the session creates,
   * so a support lookup in the Stripe dashboard finds the LaunchOS record
   * from either end.
   */
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<PaymentsCheckoutSession> {
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    if (input.priceId) lineItems.push({ price: input.priceId, quantity: 1 });
    if (input.oneOff) {
      lineItems.push({
        price_data: {
          currency: input.oneOff.currency.toLowerCase(),
          unit_amount: input.oneOff.amountPence,
          product_data: { name: input.oneOff.description },
        },
        quantity: 1,
      });
    }
    if (lineItems.length === 0) throw new Error("payments: a checkout session needs a price or a one-off amount");
    const mode = input.priceId ? "subscription" : "payment";
    const session = await this.client.checkout.sessions.create({
      mode,
      line_items: lineItems,
      customer_email: input.customerEmail,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReference,
      metadata: input.metadata,
      ...(mode === "subscription"
        ? { subscription_data: { metadata: input.metadata } }
        : { payment_intent_data: { metadata: input.metadata } }),
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
      status: subscriptionStatusFromProvider(s.status),
      currentPeriodStart: periodOf(s, "current_period_start"),
      currentPeriodEnd: periodOf(s, "current_period_end"),
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

/** Walks a Stripe list to its end. Stripe pages are cursor-based: the last id of one page opens the next. */
async function paginate<T extends { id: string }>(
  page: (startingAfter: string | undefined) => Promise<{ data: T[]; has_more: boolean }>,
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const result = await page(startingAfter);
    all.push(...result.data);
    const last = result.data[result.data.length - 1];
    if (!result.has_more || !last) return all;
    startingAfter = last.id;
  }
}

function toCustomer(c: Stripe.Customer): PaymentsCustomer {
  return {
    id: c.id,
    name: c.name ?? "",
    ...(c.email ? { email: c.email } : {}),
  };
}

const BILLING_INTERVALS: ReadonlySet<string> = new Set(["day", "week", "month", "year"]);

/** Null for a one-off price, a non-Stripe id, or a product that is missing or deleted. */
function toCatalogItem(price: Stripe.Price): PaymentsCatalogItem | null {
  if (!isProviderId("price", price.id) || !price.recurring) return null;
  const product = price.product;
  if (typeof product === "string" || !product || product.deleted) return null;
  if (!isProviderId("prod", product.id) || !BILLING_INTERVALS.has(price.recurring.interval)) return null;
  return {
    priceId: price.id,
    productId: product.id,
    productName: product.name,
    productActive: product.active,
    amountPence: price.unit_amount ?? 0,
    currency: price.currency.toUpperCase(),
    interval: price.recurring.interval as PaymentsBillingInterval,
    intervalCount: price.recurring.interval_count,
  };
}

/**
 * The current period as the API version in use reports it: on the first
 * subscription item, with the subscription's own (older) top-level field as
 * the fallback, and the start date behind both so a date always comes back.
 */
function periodOf(s: Stripe.Subscription, field: "current_period_start" | "current_period_end"): Date {
  const item = s.items.data[0] as (Stripe.SubscriptionItem & Partial<Record<typeof field, number | null>>) | undefined;
  const topLevel = (s as unknown as Partial<Record<typeof field, number | null>>)[field];
  const seconds = item?.[field] ?? topLevel ?? s.start_date;
  return new Date(seconds * 1000);
}

/** Null for a subscription with no Stripe-shaped price (nothing the sync could file it under). */
function toSubscriptionDetail(s: Stripe.Subscription): PaymentsSubscriptionDetail | null {
  const item = s.items.data[0];
  const priceId = item?.price.id;
  const productRef = item?.price.product;
  const productId = typeof productRef === "string" ? productRef : productRef?.id;
  if (!isProviderId("price", priceId) || !isProviderId("prod", productId)) return null;
  const customer = typeof s.customer === "string" ? undefined : (s.customer.deleted ? undefined : s.customer);
  const customerId = typeof s.customer === "string" ? s.customer : s.customer.id;
  return {
    id: s.id,
    status: subscriptionStatusFromProvider(s.status),
    providerStatus: s.status,
    customerId,
    ...(customer?.email ? { customerEmail: customer.email } : {}),
    ...(customer?.name ? { customerName: customer.name } : {}),
    priceId,
    productId,
    amountPence: (item?.price.unit_amount ?? 0) * (item?.quantity ?? 1),
    currency: (item?.price.currency ?? "gbp").toUpperCase(),
    currentPeriodStart: periodOf(s, "current_period_start"),
    currentPeriodEnd: periodOf(s, "current_period_end"),
    ...(s.cancel_at ? { cancelAt: new Date(s.cancel_at * 1000) } : {}),
    ...(s.canceled_at ? { canceledAt: new Date(s.canceled_at * 1000) } : {}),
    createdAt: new Date(s.created * 1000),
  };
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
