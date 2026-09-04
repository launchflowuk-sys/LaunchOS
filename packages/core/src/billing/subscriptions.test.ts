import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { activeSubscriptionForClient, cancelSubscription, createSubscription } from "./subscriptions.js";

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sub-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}`, email: "info@grays.test" })
    .returning();
  await db.insert(schema.billingProfiles)
    .values({ organisationId: org!.id, clientId: client!.id, billingName: "Grays CabLine Ltd" });
  const [pkg] = await db.insert(schema.packages)
    .values({ organisationId: org!.id, name: "Growth", slug: `growth-${randomUUID()}`, monthlyPricePence: 29900, setupPricePence: 0 })
    .returning();
  return { orgId: org!.id, clientId: client!.id, packageId: pkg!.id };
}

describe("createSubscription", () => {
  it("creates the provider customer, stores its id on the billing profile and returns the first invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      const payments = new MockPaymentsAdapter({ vatRatePercent: 20 });

      const { subscription, providerInvoice } = await createSubscription(
        db, orgId,
        { clientId, packageId, periodStart: new Date("2026-09-01T00:00:00Z"), actorKind: "user", actorId: "u1" },
        payments,
      );

      expect(subscription.status).toBe("active");
      expect(subscription.amountPence).toBe(29900);
      expect(subscription.stripeSubscriptionId).toMatch(/^mock_sub_/);
      expect(providerInvoice.totalPence).toBe(35880);

      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
      expect(profile!.stripeCustomerId).toMatch(/^mock_cus_/);

      const found = await activeSubscriptionForClient(db, orgId, clientId);
      expect(found?.id).toBe(subscription.id);
    });
  });

  it("reuses an existing provider customer id", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      await db.update(schema.billingProfiles)
        .set({ stripeCustomerId: "mock_cus_existing" })
        .where(eq(schema.billingProfiles.clientId, clientId));

      await createSubscription(db, orgId, { clientId, packageId, periodStart: new Date("2026-09-01T00:00:00Z") }, new MockPaymentsAdapter());

      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
      expect(profile!.stripeCustomerId).toBe("mock_cus_existing");
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const { clientId, packageId } = await fixture(db);
      const [other] = await db.insert(schema.organisations).values({ name: "O", slug: `oth-${randomUUID()}` }).returning();
      await expect(
        createSubscription(db, other!.id, { clientId, packageId, periodStart: new Date() }, new MockPaymentsAdapter()),
      ).rejects.toThrow(/not found in organisation/);
    });
  });
});

describe("cancelSubscription", () => {
  it("cancels at the provider and locally", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      const payments = new MockPaymentsAdapter();
      const { subscription } = await createSubscription(db, orgId, { clientId, packageId, periodStart: new Date() }, payments);

      const cancelled = await cancelSubscription(db, orgId, { subscriptionId: subscription.id, actorKind: "user", actorId: "u1" }, payments);

      expect(cancelled.status).toBe("cancelled");
      expect(await activeSubscriptionForClient(db, orgId, clientId)).toBeUndefined();
    });
  });
});
