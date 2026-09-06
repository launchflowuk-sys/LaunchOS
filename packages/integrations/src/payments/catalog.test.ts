import { describe, expect, it } from "vitest";
import { MockPaymentsAdapter } from "./mock.js";
import { StripePaymentsAdapter } from "./stripe.js";
import { subscriptionStatusFromProvider } from "./types.js";

const OPTIONS = { secretKey: "sk_test_dummy", webhookSecret: "whsec_test_dummy" };

function withFakeClient(fake: Record<string, unknown>): StripePaymentsAdapter {
  const adapter = new StripePaymentsAdapter(OPTIONS);
  (adapter as unknown as { client: unknown }).client = fake;
  return adapter;
}

const PRODUCT_BASIC = { id: "prod_basic", name: "LaunchFlow Basic Ad Management", active: true };
const PRODUCT_CABIO = { id: "prod_cabio", name: "Cabio Solo", active: true };

describe("StripePaymentsAdapter.listCatalog", () => {
  it("walks every page, expands the product, and skips one-off prices, deleted products and non-Stripe ids", async () => {
    const calls: unknown[] = [];
    const adapter = withFakeClient({
      prices: {
        list: async (params: { starting_after?: string }) => {
          calls.push(params);
          if (!params.starting_after) {
            return {
              has_more: true,
              data: [
                { id: "price_basic_m", product: PRODUCT_BASIC, recurring: { interval: "month", interval_count: 1 }, unit_amount: 5000, currency: "gbp" },
                { id: "fluentform_3_2999_month_GBP", product: { id: "1", name: "Junk", active: true }, recurring: { interval: "month", interval_count: 1 }, unit_amount: 2999, currency: "gbp" },
                { id: "price_oneoff", product: PRODUCT_BASIC, recurring: null, unit_amount: 100, currency: "gbp" },
              ],
            };
          }
          return {
            has_more: false,
            data: [
              { id: "price_cabio_y", product: PRODUCT_CABIO, recurring: { interval: "year", interval_count: 1 }, unit_amount: 99900, currency: "gbp" },
              { id: "price_gone", product: { id: "prod_gone", deleted: true }, recurring: { interval: "month", interval_count: 1 }, unit_amount: 1, currency: "gbp" },
              { id: "price_unexpanded", product: "prod_string", recurring: { interval: "month", interval_count: 1 }, unit_amount: 1, currency: "gbp" },
            ],
          };
        },
      },
    });

    const catalog = await adapter.listCatalog();

    expect(calls).toEqual([
      { active: true, type: "recurring", limit: 100, expand: ["data.product"] },
      { active: true, type: "recurring", limit: 100, expand: ["data.product"], starting_after: "price_oneoff" },
    ]);
    expect(catalog).toEqual([
      { priceId: "price_basic_m", productId: "prod_basic", productName: "LaunchFlow Basic Ad Management", productActive: true, amountPence: 5000, currency: "GBP", interval: "month", intervalCount: 1 },
      { priceId: "price_cabio_y", productId: "prod_cabio", productName: "Cabio Solo", productActive: true, amountPence: 99900, currency: "GBP", interval: "year", intervalCount: 1 },
    ]);
  });
});

describe("StripePaymentsAdapter.listSubscriptions", () => {
  it("reads the period from the first item, falls back to the top level, maps statuses and the expanded customer", async () => {
    const adapter = withFakeClient({
      subscriptions: {
        list: async () => ({
          has_more: false,
          data: [
            {
              id: "sub_1", status: "active", created: 1_700_000_000, cancel_at: null, canceled_at: null, start_date: 1_700_000_000,
              customer: { id: "cus_1", email: "info@lakeside.example", name: "Lakeside and Purfleet Taxis ltd", deleted: false },
              current_period_start: null, current_period_end: null,
              items: { data: [{ quantity: 1, current_period_start: 1_735_689_600, current_period_end: 1_738_368_000, price: { id: "price_basic_m", product: "prod_basic", unit_amount: 5000, currency: "gbp" } }] },
            },
            {
              id: "sub_2", status: "incomplete_expired", created: 1_600_000_000, cancel_at: 1_800_000_000, canceled_at: 1_790_000_000, start_date: 1_600_000_000,
              customer: { id: "cus_2", deleted: true },
              current_period_start: 1_600_000_000, current_period_end: 1_602_592_000,
              items: { data: [{ quantity: 2, price: { id: "price_cabio_y", product: { id: "prod_cabio" }, unit_amount: 1000, currency: "gbp" } }] },
            },
            {
              id: "sub_junk", status: "active", created: 1, start_date: 1, customer: "cus_3",
              items: { data: [{ price: { id: "fluentform_3", product: "1", unit_amount: 1, currency: "gbp" } }] },
            },
          ],
        }),
      },
    });

    const subscriptions = await adapter.listSubscriptions();

    expect(subscriptions).toEqual([
      {
        id: "sub_1", status: "active", providerStatus: "active", customerId: "cus_1",
        customerEmail: "info@lakeside.example", customerName: "Lakeside and Purfleet Taxis ltd",
        priceId: "price_basic_m", productId: "prod_basic", amountPence: 5000, currency: "GBP",
        currentPeriodStart: new Date(1_735_689_600 * 1000), currentPeriodEnd: new Date(1_738_368_000 * 1000),
        createdAt: new Date(1_700_000_000 * 1000),
      },
      {
        id: "sub_2", status: "cancelled", providerStatus: "incomplete_expired", customerId: "cus_2",
        priceId: "price_cabio_y", productId: "prod_cabio", amountPence: 2000, currency: "GBP",
        currentPeriodStart: new Date(1_600_000_000 * 1000), currentPeriodEnd: new Date(1_602_592_000 * 1000),
        cancelAt: new Date(1_800_000_000 * 1000), canceledAt: new Date(1_790_000_000 * 1000),
        createdAt: new Date(1_600_000_000 * 1000),
      },
    ]);
  });

  it("retrieves a customer and refuses a deleted one", async () => {
    const adapter = withFakeClient({
      customers: {
        retrieve: async (id: string) => (id === "cus_gone"
          ? { id, deleted: true }
          : { id, name: "Chathwell windows ltd", email: "hello@chathwell.example", deleted: false }),
      },
    });
    expect(await adapter.retrieveCustomer("cus_1")).toEqual({ id: "cus_1", name: "Chathwell windows ltd", email: "hello@chathwell.example" });
    await expect(adapter.retrieveCustomer("cus_gone")).rejects.toThrow(/deleted/);
  });
});

describe("subscriptionStatusFromProvider", () => {
  it("maps every Stripe status into the five local ones", () => {
    expect(["trialing", "active", "past_due", "paused"].map(subscriptionStatusFromProvider)).toEqual(["trialing", "active", "past_due", "paused"]);
    expect(["canceled", "unpaid", "incomplete", "incomplete_expired"].map(subscriptionStatusFromProvider)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(subscriptionStatusFromProvider("something_new")).toBe("paused");
  });
});

describe("MockPaymentsAdapter catalogue", () => {
  it("returns what was seeded and answers retrieveCustomer from the seeded subscriptions", async () => {
    const payments = new MockPaymentsAdapter();
    expect(await payments.listCatalog()).toEqual([]);
    expect(await payments.listSubscriptions()).toEqual([]);

    payments.seedCatalog([{ priceId: "price_a", productId: "prod_a", productName: "A", productActive: true, amountPence: 100, currency: "GBP", interval: "month", intervalCount: 1 }]);
    payments.seedSubscriptions([{
      id: "sub_a", status: "active", providerStatus: "active", customerId: "cus_a", customerEmail: "a@example.test", customerName: "A Ltd",
      priceId: "price_a", productId: "prod_a", amountPence: 100, currency: "GBP",
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"),
    }]);

    expect((await payments.listCatalog()).map((c) => c.priceId)).toEqual(["price_a"]);
    expect((await payments.listSubscriptions()).map((s) => s.id)).toEqual(["sub_a"]);
    expect(await payments.retrieveCustomer("cus_a")).toEqual({ id: "cus_a", name: "A Ltd", email: "a@example.test" });
    await expect(payments.retrieveCustomer("cus_real")).rejects.toThrow(/not a mock customer id/);
  });
});
