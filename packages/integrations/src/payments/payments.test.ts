import { describe, expect, it } from "vitest";
import { MockPaymentsAdapter, createPaymentsAdapter, vatRateFromEnv } from "./index.js";

const period = new Date("2026-09-01T00:00:00Z");

describe("MockPaymentsAdapter", () => {
  it("issues mock_ ids and one invoice per subscription", async () => {
    const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
    const customer = await payments.createCustomer({ name: "Grays CabLine", email: "info@grayscabline.co.uk", clientRef: "grays-cabline" });
    expect(customer.id).toMatch(/^mock_cus_/);

    const { subscription, invoice } = await payments.createSubscription({
      customerId: customer.id, amountPence: 29900, currency: "GBP", description: "Growth package", periodStart: period,
    });
    expect(subscription.id).toMatch(/^mock_sub_/);
    expect(subscription.status).toBe("active");
    expect(subscription.currentPeriodEnd > subscription.currentPeriodStart).toBe(true);
    expect(invoice.id).toMatch(/^mock_in_/);
    expect(invoice.subtotalPence).toBe(29900);
    expect(invoice.vatPence).toBe(5980);
    expect(invoice.totalPence).toBe(35880);
    expect(await payments.listInvoices(customer.id)).toHaveLength(1);
  });

  it("generates a further invoice on advancePeriod and rolls the period forward", async () => {
    const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
    const customer = await payments.createCustomer({ name: "C", clientRef: "c" });
    const { subscription } = await payments.createSubscription({
      customerId: customer.id, amountPence: 10000, currency: "GBP", description: "P", periodStart: period,
    });
    const second = payments.advancePeriod(subscription.id);
    expect(second.id).not.toBe(subscription.id);
    expect(await payments.listInvoices(customer.id)).toHaveLength(2);
    const cancelled = await payments.cancelSubscription(subscription.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("never issues the same id twice, in this process or the next one", async () => {
    const first = new MockPaymentsAdapter();
    const second = new MockPaymentsAdapter();
    const customer = await first.createCustomer({ name: "C", clientRef: "c" });
    const ids = new Set<string>();
    for (const payments of [first, second, first]) {
      const { subscription } = await payments.createSubscription({
        customerId: customer.id, amountPence: 10000, currency: "GBP", description: "P", periodStart: period,
      });
      ids.add(subscription.id);
    }
    // A counter would have handed `second` the same id as `first` — which is
    // exactly what a dev-server restart looks like — and violated
    // subscriptions_org_stripe_id.
    expect(ids.size).toBe(3);
  });

  it("cancels a subscription it has never seen, so a restart cannot strand one", async () => {
    const before = new MockPaymentsAdapter();
    const customer = await before.createCustomer({ name: "C", clientRef: "c" });
    const { subscription } = await before.createSubscription({
      customerId: customer.id, amountPence: 10000, currency: "GBP", description: "P", periodStart: period,
    });

    // The database still holds the id; the process that issued it is gone.
    const afterRestart = new MockPaymentsAdapter();
    const cancelled = await afterRestart.cancelSubscription(subscription.id);
    expect(cancelled.id).toBe(subscription.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await afterRestart.getSubscription(subscription.id)).status).toBe("cancelled");
  });

  it("reads back an unknown id as active and refuses an id no mock could have issued", async () => {
    const payments = new MockPaymentsAdapter();
    const orphan = `mock_sub_${crypto.randomUUID()}`;
    expect((await payments.getSubscription(orphan)).status).toBe("active");
    await expect(payments.cancelSubscription("sub_live_123")).rejects.toThrow(/not a mock subscription id/);
  });

  it("verifies a mock webhook body and rejects a bad signature", () => {
    const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "mock_in_1" } } });
    expect(payments.webhookVerify(body, "mock").type).toBe("invoice.paid");
    expect(() => payments.webhookVerify(body, "nope")).toThrow(/signature/i);
  });
});

describe("vatRateFromEnv", () => {
  it("treats a blank VAT_RATE as unset rather than as 0%", () => {
    expect(vatRateFromEnv({ VAT_RATE: "" } as NodeJS.ProcessEnv)).toBe(20);
    expect(vatRateFromEnv({ VAT_RATE: "  " } as NodeJS.ProcessEnv)).toBe(20);
    expect(vatRateFromEnv({} as NodeJS.ProcessEnv)).toBe(20);
  });

  it("keeps a usable rate and rejects an out-of-range one", () => {
    expect(vatRateFromEnv({ VAT_RATE: "5" } as NodeJS.ProcessEnv)).toBe(5);
    expect(vatRateFromEnv({ VAT_RATE: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(vatRateFromEnv({ VAT_RATE: "nope" } as NodeJS.ProcessEnv)).toBe(20);
    expect(vatRateFromEnv({ VAT_RATE: "250" } as NodeJS.ProcessEnv)).toBe(20);
  });
});

describe("createPaymentsAdapter", () => {
  it("returns the mock adapter when Stripe is not configured", () => {
    expect(createPaymentsAdapter({ PAYMENTS_ADAPTER: "stripe" } as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createPaymentsAdapter({} as NodeJS.ProcessEnv).name).toBe("mock");
  });

  it("returns the Stripe adapter when the secret key is present", () => {
    const env = { PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: "whsec_123" } as unknown as NodeJS.ProcessEnv;
    expect(createPaymentsAdapter(env).name).toBe("stripe");
  });
});
