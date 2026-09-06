import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter, type PaymentsAdapter } from "@launchos/integrations";
import { STRIPE_RECONCILE_CRON, runStripeReconcile } from "./stripe-reconcile.js";

function silent() {
  const lines: unknown[] = [];
  return { logger: { info: (...args: unknown[]) => { lines.push(args); } }, lines };
}

/** The mock adapter wearing Stripe's name, so the job runs the real reconcile against seeded data. */
function stripeLike(payments: MockPaymentsAdapter): PaymentsAdapter {
  return Object.assign(Object.create(payments) as MockPaymentsAdapter, { name: "stripe" as const });
}

describe("runStripeReconcile", () => {
  it("runs at 04:10 London", () => {
    expect(STRIPE_RECONCILE_CRON).toBe("10 4 * * *");
  });

  it("skips and logs on the mock adapter, and reconciles on Stripe", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `stripe-recon-${crypto.randomUUID()}` }).returning();
      await db.insert(schema.packages).values({ organisationId: org!.id, name: "Basic", slug: "basic", stripeProductId: "prod_basic" });
      const payments = new MockPaymentsAdapter();
      payments.seedCatalog([{ priceId: "price_basic", productId: "prod_basic", productName: "LaunchFlow Basic", productActive: true, amountPence: 5000, currency: "GBP", interval: "month", intervalCount: 1 }]);
      payments.seedSubscriptions([{
        id: "sub_1", status: "active", providerStatus: "active", customerId: "cus_1", customerName: "new client ltd", customerEmail: "new@example.test",
        priceId: "price_basic", productId: "prod_basic", amountPence: 5000, currency: "GBP",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"),
      }]);

      const { logger, lines } = silent();
      expect(await runStripeReconcile(db, org!.id, payments, logger)).toEqual({ skipped: "not_stripe", adapter: "mock" });
      expect(await db.select().from(schema.clients).where(eq(schema.clients.organisationId, org!.id))).toHaveLength(0);
      expect(lines).toHaveLength(1);

      const result = await runStripeReconcile(db, org!.id, stripeLike(payments), logger);
      expect(result.skipped).toBeUndefined();
      expect(result.skipped === undefined && result.summary.clients.created.map((c) => c.name)).toEqual(["New Client Ltd"]);
      const clients = await db.select().from(schema.clients).where(eq(schema.clients.organisationId, org!.id));
      expect(clients.map((c) => c.name)).toEqual(["New Client Ltd"]);
    });
  });
});
