import { describe, expect, it } from "vitest";
import { MockPaymentsAdapter } from "./mock.js";
import { StripePaymentsAdapter, toCheckoutSession } from "./stripe.js";

const input = {
  priceId: "price_growth",
  customerEmail: "owner@grays.test",
  successUrl: "http://localhost:3000/signup/done?session_id={CHECKOUT_SESSION_ID}",
  cancelUrl: "http://localhost:3000/signup?package=growth",
  clientReference: "lead-1",
  metadata: { launchos: "signup", organisationId: "org-1", packageId: "pkg-1" },
};

describe("MockPaymentsAdapter checkout", () => {
  it("issues an open session whose url is the success url with the id filled in, then completes it", async () => {
    const payments = new MockPaymentsAdapter();
    const session = await payments.createCheckoutSession(input);
    expect(session.id).toMatch(/^mock_cs_/);
    expect(session.status).toBe("open");
    expect(session.url).toBe(`http://localhost:3000/signup/done?session_id=${session.id}`);
    expect(session.metadata).toMatchObject({ launchos: "signup", organisationId: "org-1", priceId: "price_growth" });

    // Coming back from the "hosted page" completes it.
    const done = await payments.retrieveCheckoutSession(session.id);
    expect(done.status).toBe("complete");
    expect(done.paymentStatus).toBe("paid");
    expect(done.customerId).toMatch(/^mock_cus_/);
    expect(done.subscriptionId).toMatch(/^mock_sub_/);
    expect(done.customerEmail).toBe("owner@grays.test");
    expect((await payments.retrieveCheckoutSession(session.id)).status).toBe("complete");
  });

  it("reconstructs a never-seen mock session as complete and refuses a foreign id", async () => {
    const payments = new MockPaymentsAdapter();
    const recalled = await payments.retrieveCheckoutSession("mock_cs_00000000-0000-0000-0000-000000000000");
    expect(recalled.status).toBe("complete");
    expect(recalled.customerId).toMatch(/^mock_cus_/);
    await expect(payments.retrieveCheckoutSession("cs_test_real")).rejects.toThrow(/not a mock checkout session id/);
  });
});

describe("StripePaymentsAdapter checkout", () => {
  it("creates a subscription-mode session with the metadata on both objects and maps it back", async () => {
    let captured: unknown;
    const adapter = new StripePaymentsAdapter({ secretKey: "sk_test_dummy", webhookSecret: "whsec_dummy" });
    (adapter as unknown as { client: unknown }).client = {
      checkout: {
        sessions: {
          create: async (params: unknown) => {
            captured = params;
            return {
              id: "cs_test_1", status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_test_1",
              customer: null, subscription: null, customer_email: "owner@grays.test", metadata: input.metadata,
            };
          },
          retrieve: async () => ({
            id: "cs_test_1", status: "complete", payment_status: "paid", url: null,
            customer: "cus_1", subscription: { id: "sub_1" }, customer_details: { email: "owner@grays.test" }, metadata: input.metadata,
          }),
        },
      },
    };
    const created = await adapter.createCheckoutSession(input);
    expect(captured).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_growth", quantity: 1 }],
      customer_email: "owner@grays.test",
      client_reference_id: "lead-1",
      metadata: input.metadata,
      subscription_data: { metadata: input.metadata },
    });
    expect(created).toMatchObject({ id: "cs_test_1", status: "open", paymentStatus: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect("customerId" in created).toBe(false);

    const retrieved = await adapter.retrieveCheckoutSession("cs_test_1");
    expect(retrieved).toEqual({
      id: "cs_test_1", status: "complete", paymentStatus: "paid", customerId: "cus_1", subscriptionId: "sub_1",
      customerEmail: "owner@grays.test", metadata: input.metadata,
    });
  });

  it("toCheckoutSession tolerates a bare webhook object with unknown statuses", () => {
    const mapped = toCheckoutSession({ id: "cs_x", status: "weird", payment_status: null, metadata: null } as never);
    expect(mapped).toEqual({ id: "cs_x", status: "open", paymentStatus: "unpaid", metadata: {} });
  });
});
