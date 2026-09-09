import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { activeSubscriptionForClient, cancelSubscription, createSubscription, listActiveSubscriptionsForClient } from "./subscriptions.js";

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

/**
 * One person, two Stripe subscriptions, one client row after a merge.
 *
 * `activeSubscriptionForClient` ends in `limit(1)`, and the client billing
 * screen was built on it, so a merged client showed the older subscription and
 * silently hid the newer one. Meanwhile the portfolio KPI sums every
 * subscription row, so the top line said one number and the client's own page
 * said a smaller one, with nothing on either screen to explain the gap.
 */
describe("listActiveSubscriptionsForClient", () => {
  it("returns every active subscription, oldest first, so a merged client shows both", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      const period = {
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
      };

      await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId, packageId, amountPence: 22000,
        stripeSubscriptionId: `sub_a_${randomUUID()}`, ...period,
      });
      await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId, packageId, amountPence: 11000,
        stripeSubscriptionId: `sub_b_${randomUUID()}`, ...period,
      });

      const all = await listActiveSubscriptionsForClient(db, orgId, clientId);

      expect(all).toHaveLength(2);
      expect(all.reduce((sum, s) => sum + s.amountPence, 0)).toBe(33000);
      // The singular reader still answers with one, which is why the screen
      // that used it could not show the second.
      const one = await activeSubscriptionForClient(db, orgId, clientId);
      expect(one).toBeDefined();
      expect(all.some((s) => s.id === one!.id)).toBe(true);
    });
  });

  it("leaves out cancelled subscriptions so a total is what they actually pay", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, packageId } = await fixture(db);
      const period = {
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
      };
      await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId, packageId, amountPence: 22000,
        stripeSubscriptionId: `sub_live_${randomUUID()}`, ...period,
      });
      await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId, packageId, amountPence: 99900, status: "cancelled",
        stripeSubscriptionId: `sub_dead_${randomUUID()}`, ...period,
      });

      const all = await listActiveSubscriptionsForClient(db, orgId, clientId);
      expect(all).toHaveLength(1);
      expect(all[0]!.amountPence).toBe(22000);
    });
  });
});
