import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripePaymentsAdapter } from "./stripe.js";

const SECRET_KEY = "sk_test_dummy";
const WEBHOOK_SECRET = "whsec_test_dummy";

/** Replaces the adapter's private Stripe client with a fake so no network call is ever made. */
function withFakeClient(adapter: StripePaymentsAdapter, fake: Record<string, unknown>): StripePaymentsAdapter {
  (adapter as unknown as { client: unknown }).client = fake;
  return adapter;
}

describe("StripePaymentsAdapter", () => {
  it("verifies a real Stripe webhook signature and rejects a mismatched secret", () => {
    const adapter = new StripePaymentsAdapter({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET });
    const payload = JSON.stringify({ id: "evt_123", type: "invoice.paid", data: { object: { id: "in_123" } } });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const event = adapter.webhookVerify(payload, header);
    expect(event).toEqual({ id: "evt_123", type: "invoice.paid", data: { object: { id: "in_123" } } });

    const wrongHeader = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    expect(() => adapter.webhookVerify(payload, wrongHeader)).toThrow();
  });

  it("maps a created customer and omits email when Stripe returns none", async () => {
    const adapter = withFakeClient(
      new StripePaymentsAdapter({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET }),
      { customers: { create: async () => ({ id: "cus_1", name: "Grays CabLine", email: null }) } },
    );
    const customer = await adapter.createCustomer({ name: "Grays CabLine", clientRef: "grays-cabline" });
    expect(customer).toEqual({ id: "cus_1", name: "Grays CabLine" });
    expect("email" in customer).toBe(false);
  });

  it("creates a price-backed subscription and maps the expanded invoice, including VAT from total_taxes", async () => {
    const fakeSubscription = {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      items: {
        data: [{
          current_period_start: 1_735_689_600,
          current_period_end: 1_738_368_000,
          price: { unit_amount: 29900, currency: "gbp" },
        }],
      },
      start_date: 1_735_689_600,
      latest_invoice: {
        id: "in_1",
        customer: "cus_1",
        parent: { subscription_details: { subscription: "sub_1" } },
        status: "open",
        created: 1_735_689_600,
        due_date: 1_736_899_200,
        subtotal: 29900,
        total_taxes: [{ amount: 5980 }],
        total: 35880,
        currency: "gbp",
        hosted_invoice_url: "https://stripe.example/invoice/in_1",
        invoice_pdf: "https://stripe.example/invoice/in_1.pdf",
      },
    };
    let capturedPriceParams: unknown;
    let capturedSubscriptionParams: unknown;
    const adapter = withFakeClient(
      new StripePaymentsAdapter({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET }),
      {
        prices: {
          create: async (params: unknown) => {
            capturedPriceParams = params;
            return { id: "price_1" };
          },
        },
        subscriptions: {
          create: async (params: unknown) => {
            capturedSubscriptionParams = params;
            return fakeSubscription;
          },
        },
      },
    );

    const { subscription, invoice } = await adapter.createSubscription({
      customerId: "cus_1", amountPence: 29900, currency: "GBP", description: "Growth package",
      periodStart: new Date("2025-01-01T00:00:00Z"),
    });

    expect(capturedPriceParams).toMatchObject({
      currency: "gbp", unit_amount: 29900, product_data: { name: "Growth package" }, recurring: { interval: "month" },
    });
    expect(capturedSubscriptionParams).toMatchObject({ items: [{ price: "price_1" }] });

    expect(subscription).toEqual({
      id: "sub_1", customerId: "cus_1", status: "active",
      currentPeriodStart: new Date(1_735_689_600 * 1000),
      currentPeriodEnd: new Date(1_738_368_000 * 1000),
      amountPence: 29900, currency: "GBP",
    });
    expect(invoice).toEqual({
      id: "in_1", customerId: "cus_1", subscriptionId: "sub_1", status: "sent",
      issuedAt: new Date(1_735_689_600 * 1000), dueAt: new Date(1_736_899_200 * 1000),
      subtotalPence: 29900, vatPence: 5980, totalPence: 35880, currency: "GBP",
      hostedUrl: "https://stripe.example/invoice/in_1", pdfUrl: "https://stripe.example/invoice/in_1.pdf",
    });
  });

  it("lists invoices for a customer", async () => {
    const adapter = withFakeClient(
      new StripePaymentsAdapter({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET }),
      {
        invoices: {
          list: async () => ({
            data: [{
              id: "in_2", customer: "cus_1", status: "paid", created: 1_735_689_600,
              subtotal: 10000, total_taxes: [], total: 10000, currency: "gbp",
            }],
          }),
        },
      },
    );
    const invoices = await adapter.listInvoices("cus_1");
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ id: "in_2", status: "paid", totalPence: 10000, vatPence: 0 });
  });

  it("cancels a subscription", async () => {
    const adapter = withFakeClient(
      new StripePaymentsAdapter({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET }),
      {
        subscriptions: {
          cancel: async () => ({
            id: "sub_1", customer: "cus_1", status: "canceled",
            items: { data: [{ current_period_start: 0, current_period_end: 0, price: { unit_amount: 0, currency: "gbp" } }] },
            start_date: 0,
          }),
        },
      },
    );
    const cancelled = await adapter.cancelSubscription("sub_1");
    expect(cancelled.status).toBe("cancelled");
  });
});
