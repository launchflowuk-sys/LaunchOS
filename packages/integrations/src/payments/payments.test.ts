import { describe, expect, it } from "vitest";
import { MockPaymentsAdapter, createPaymentsAdapter } from "./index.js";

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

  it("verifies a mock webhook body and rejects a bad signature", () => {
    const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "mock_in_1" } } });
    expect(payments.webhookVerify(body, "mock").type).toBe("invoice.paid");
    expect(() => payments.webhookVerify(body, "nope")).toThrow(/signature/i);
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
