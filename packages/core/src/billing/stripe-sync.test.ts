import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter, type PaymentsCatalogItem, type PaymentsSubscriptionDetail } from "@launchos/integrations";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { businessCase, proposedClientName } from "./stripe-sync-match.js";
import { getStripeSyncSettings } from "./stripe-sync-settings.js";
import { applyStripeSync, previewStripeSync, reconcileStripe } from "./stripe-sync.js";
import { syncFromPaymentsEvent } from "./webhook-sync.js";

const price = (over: Partial<PaymentsCatalogItem> & Pick<PaymentsCatalogItem, "priceId" | "productId" | "productName">): PaymentsCatalogItem => ({
  productActive: true, amountPence: 5000, currency: "GBP", interval: "month", intervalCount: 1, ...over,
});

const CATALOG: PaymentsCatalogItem[] = [
  price({ priceId: "price_basic", productId: "prod_basic", productName: "LaunchFlow Basic Ad Management", amountPence: 5000 }),
  price({ priceId: "price_starter", productId: "prod_starter", productName: "Starter Plan", amountPence: 3500 }),
  price({ priceId: "price_starter_y", productId: "prod_starter", productName: "Starter Plan", amountPence: 36000, interval: "year" }),
  price({ priceId: "price_cabio", productId: "prod_cabio", productName: "Cabio Solo", amountPence: 9900 }),
];

const sub = (over: Partial<PaymentsSubscriptionDetail> & Pick<PaymentsSubscriptionDetail, "id" | "customerId" | "priceId" | "productId">): PaymentsSubscriptionDetail => ({
  status: "active", providerStatus: "active", amountPence: 5000, currency: "GBP",
  currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
  createdAt: new Date("2025-01-01T00:00:00Z"), ...over,
});

function mock(catalog = CATALOG, subscriptions: PaymentsSubscriptionDetail[] = []) {
  const payments = new MockPaymentsAdapter();
  payments.seedCatalog(catalog);
  payments.seedSubscriptions(subscriptions);
  return payments;
}

async function audits(db: Db, organisationId: string, actions: string[]) {
  return db.select().from(schema.auditLog).where(and(
    eq(schema.auditLog.organisationId, organisationId), inArray(schema.auditLog.action, actions),
  ));
}

async function notifications(db: Db, organisationId: string) {
  return db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, organisationId));
}

describe("businessCase / proposedClientName", () => {
  it("cases a Stripe customer name the way a business writes it", () => {
    expect(businessCase("Lakeside and Purfleet Taxis ltd")).toBe("Lakeside and Purfleet Taxis Ltd");
    expect(businessCase("Monika  Obidzinska")).toBe("Monika Obidzinska");
    expect(businessCase("chathwell windows LTD")).toBe("Chathwell Windows Ltd");
    expect(businessCase("Grays CabLine")).toBe("Grays CabLine");
    expect(proposedClientName({ customerId: "cus_1", customerEmail: "info@grays-taxis.co.uk" })).toBe("Info");
    expect(proposedClientName({ customerId: "cus_1" })).toBe("Stripe customer cus_1");
  });
});

describe("previewStripeSync", () => {
  it("suggests LaunchFlow and known plan names, leaves ignored and other products unticked, and matches packages and clients", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await db.update(schema.packages).set({ stripePriceId: "price_starter_y" }).where(eq(schema.packages.id, packageId));
      await db.update(schema.clients).set({ email: "Owner@Lakeside.example" }).where(eq(schema.clients.id, clientId));
      const [other] = await db.insert(schema.clients).values({ organisationId, name: "By profile", slug: `p-${randomUUID()}` }).returning();
      await db.insert(schema.billingProfiles).values({ organisationId, clientId: other!.id, stripeCustomerId: "cus_profile" });
      await db.update(schema.organisations)
        .set({ metadata: { stripeSync: { ignoredProductIds: ["prod_basic"] } } })
        .where(eq(schema.organisations.id, organisationId));

      const payments = mock(CATALOG, [
        sub({ id: "sub_profile", customerId: "cus_profile", priceId: "price_starter", productId: "prod_starter" }),
        sub({ id: "sub_email", customerId: "cus_email", customerEmail: "owner@lakeside.example", priceId: "price_starter", productId: "prod_starter" }),
        sub({ id: "sub_new", customerId: "cus_new", customerName: "chathwell windows ltd", priceId: "price_basic", productId: "prod_basic" }),
        sub({ id: "sub_gone", customerId: "cus_gone", status: "cancelled", providerStatus: "canceled", priceId: "price_starter", productId: "prod_starter" }),
        sub({ id: "sub_cabio", customerId: "cus_cabio", priceId: "price_cabio", productId: "prod_cabio" }),
      ]);
      const preview = await previewStripeSync(db, organisationId, payments);

      expect(preview.products.map((p) => [p.productId, p.suggested, p.ignored, p.matchedPackageId])).toEqual([
        ["prod_basic", false, true, null],
        ["prod_starter", true, false, packageId],
        ["prod_cabio", false, false, null],
      ]);
      expect(preview.products[1]!.prices.map((p) => p.priceId)).toEqual(["price_starter", "price_starter_y"]);

      const byId = new Map(preview.subscriptions.map((s) => [s.id, s]));
      expect(byId.get("sub_profile")).toMatchObject({ matchedClientId: other!.id, matchedBy: "billing_profile", willImport: true, willCreateClient: false });
      expect(byId.get("sub_email")).toMatchObject({ matchedClientId: clientId, matchedBy: "email", willImport: true, willCreateClient: false });
      expect(byId.get("sub_new")).toMatchObject({
        matchedClientId: null, proposedClientName: "Chathwell Windows Ltd", productSuggested: false, willImport: false, willCreateClient: false,
      });
      expect(byId.get("sub_gone")).toMatchObject({ matchedClientId: null, productSuggested: true, willImport: false, willCreateClient: false });
      expect(byId.get("sub_cabio")).toMatchObject({ productName: "Cabio Solo", productSuggested: false, willImport: false });
    });
  });
});

describe("applyStripeSync", () => {
  it("creates packages, clients and subscriptions for the selected products, remembers the rest as ignored, and is idempotent", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const payments = mock(CATALOG, [
        sub({ id: "sub_a", customerId: "cus_a", customerEmail: "Hello@Chathwell.example", customerName: "chathwell windows ltd", priceId: "price_basic", productId: "prod_basic" }),
        sub({ id: "sub_b", customerId: "cus_b", customerName: "Monika  Obidzinska", priceId: "price_starter_y", productId: "prod_starter", amountPence: 36000, createdAt: new Date("2024-06-01T00:00:00Z") }),
        sub({ id: "sub_b2", customerId: "cus_b", customerName: "Monika  Obidzinska", priceId: "price_basic", productId: "prod_basic", createdAt: new Date("2025-06-01T00:00:00Z") }),
        sub({ id: "sub_gone", customerId: "cus_gone", status: "cancelled", providerStatus: "incomplete_expired", priceId: "price_basic", productId: "prod_basic" }),
        sub({ id: "sub_cabio", customerId: "cus_cabio", priceId: "price_cabio", productId: "prod_cabio" }),
      ]);

      const summary = await applyStripeSync(db, organisationId, payments, {
        selectedProductIds: ["prod_basic", "prod_starter"], clientNames: { cus_a: "Chathwell Windows" }, actorId: ownerUserId,
      });

      expect(summary.packages.created.map((p) => p.name).sort()).toEqual(["LaunchFlow Basic Ad Management", "Starter Plan"]);
      expect(summary.clients.created.map((c) => c.name).sort()).toEqual(["Chathwell Windows", "Monika Obidzinska"]);
      expect(summary.subscriptions).toEqual({ created: 3, updated: 0, unchanged: 0, skipped: 1 });
      expect(summary.statusChanges).toEqual([]);

      const packages = await db.select().from(schema.packages).where(eq(schema.packages.organisationId, organisationId));
      const starter = packages.find((p) => p.stripeProductId === "prod_starter")!;
      expect(starter).toMatchObject({ name: "Starter Plan", slug: "starter-plan", monthlyPricePence: 3500, stripePriceId: "price_starter", currency: "GBP" });
      const basic = packages.find((p) => p.stripeProductId === "prod_basic")!;
      expect(packages.some((p) => p.stripeProductId === "prod_cabio")).toBe(false);

      const clients = await db.select().from(schema.clients).where(eq(schema.clients.organisationId, organisationId));
      const chathwell = clients.find((c) => c.name === "Chathwell Windows")!;
      expect(chathwell).toMatchObject({ email: "hello@chathwell.example", status: "active", packageId: basic.id });
      expect(chathwell.supportEmail).toMatch(/^chathwell-windows@/);
      const monika = clients.find((c) => c.name === "Monika Obidzinska")!;
      // Two subscriptions: the newer live one (Basic, 2025) decides the package.
      expect(monika.packageId).toBe(basic.id);

      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, chathwell.id));
      expect(profile!.stripeCustomerId).toBe("cus_a");

      const subscriptions = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.organisationId, organisationId));
      expect(subscriptions.map((s) => s.stripeSubscriptionId).sort()).toEqual(["sub_a", "sub_b", "sub_b2"]);
      expect(subscriptions.find((s) => s.stripeSubscriptionId === "sub_b")).toMatchObject({
        clientId: monika.id, packageId: starter.id, stripePriceId: "price_starter_y", amountPence: 36000, status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
      });

      expect((await getStripeSyncSettings(db, organisationId))).toMatchObject({ ignoredProductIds: ["prod_cabio"], lastSummary: { trigger: "import" } });
      const written = await audits(db, organisationId, ["stripe_sync.package_upserted", "client.created", "stripe_sync.subscription_upserted"]);
      expect(written.filter((a) => a.action === "stripe_sync.package_upserted")).toHaveLength(2);
      expect(written.filter((a) => a.action === "client.created")).toHaveLength(2);
      expect(written.filter((a) => a.action === "stripe_sync.subscription_upserted")).toHaveLength(3);
      expect(written.every((a) => a.actorKind === "user" && a.actorId === ownerUserId)).toBe(true);
      const timeline = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, chathwell.id));
      expect(timeline.map((t) => t.kind)).toEqual(["client.created"]);
      const bells = await notifications(db, organisationId);
      expect(bells).toHaveLength(1);
      expect(bells[0]).toMatchObject({ kind: "stripe_sync.completed", title: "Stripe import finished" });

      // Second run: nothing to do, nothing written.
      const again = await applyStripeSync(db, organisationId, payments, { selectedProductIds: ["prod_basic", "prod_starter"], actorId: ownerUserId });
      expect(again.packages).toEqual({ created: [], linked: [] });
      expect(again.clients).toEqual({ created: [], matched: 2 });
      expect(again.subscriptions).toEqual({ created: 0, updated: 0, unchanged: 3, skipped: 1 });
      expect(await db.select().from(schema.clients).where(eq(schema.clients.organisationId, organisationId))).toHaveLength(3);
      expect(await audits(db, organisationId, ["stripe_sync.package_upserted", "client.created", "stripe_sync.subscription_upserted"])).toHaveLength(7);
    });
  });

  it("matches an existing client by email, links its billing profile, keeps a hand-made package and files a cancelled subscription as history", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await db.update(schema.clients).set({ email: "billing@grayscabline.example" }).where(eq(schema.clients.id, clientId));
      await db.update(schema.packages).set({ stripePriceId: "price_starter", monthlyPricePence: 4000 }).where(eq(schema.packages.id, packageId));
      const payments = mock(CATALOG, [
        sub({ id: "sub_hist", customerId: "cus_grays", customerEmail: "Billing@GraysCabline.example", status: "cancelled", providerStatus: "canceled", priceId: "price_starter", productId: "prod_starter" }),
      ]);

      const summary = await applyStripeSync(db, organisationId, payments, { selectedProductIds: ["prod_starter"] });

      expect(summary.packages).toEqual({ created: [], linked: [{ id: packageId, name: "Website + SEO + Social" }] });
      expect(summary.clients).toEqual({ created: [], matched: 1 });
      const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.id, packageId));
      expect(pkg).toMatchObject({ name: "Website + SEO + Social", monthlyPricePence: 4000, stripeProductId: "prod_starter", stripePriceId: "price_starter" });
      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
      expect(profile!.stripeCustomerId).toBe("cus_grays");
      const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, "sub_hist"));
      expect(row).toMatchObject({ clientId, packageId, status: "cancelled" });
    });
  });

  it("never matches another organisation's clients, and skips a customer another organisation's profile already claims", async () => {
    await withTestDb(async (db) => {
      const mine = await seedOrgWithClient(db);
      const theirs = await seedOrgWithClient(db);
      await db.update(schema.clients).set({ email: "shared@example.test" }).where(eq(schema.clients.id, theirs.clientId));
      await db.insert(schema.billingProfiles).values({ organisationId: theirs.organisationId, clientId: theirs.clientId, stripeCustomerId: "cus_theirs" });
      const payments = mock(CATALOG, [
        // Their email, but a customer id nobody holds: a new client here, never theirs.
        sub({ id: "sub_x", customerId: "cus_x", customerEmail: "shared@example.test", customerName: "Shared Ltd", priceId: "price_basic", productId: "prod_basic" }),
        // A customer id their billing profile carries: cannot be linked or created here.
        sub({ id: "sub_theirs", customerId: "cus_theirs", customerName: "Theirs Ltd", priceId: "price_basic", productId: "prod_basic" }),
      ]);

      const summary = await applyStripeSync(db, mine.organisationId, payments, { selectedProductIds: ["prod_basic"] });

      expect(summary.clients.created.map((c) => c.name)).toEqual(["Shared Ltd"]);
      expect(summary.subscriptions).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: 1 });
      const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, "sub_x"));
      expect(row!.organisationId).toBe(mine.organisationId);
      expect(row!.clientId).not.toBe(theirs.clientId);
      expect(await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, "sub_theirs"))).toHaveLength(0);
      expect(await db.select().from(schema.packages).where(eq(schema.packages.organisationId, theirs.organisationId))).toHaveLength(1);
      expect(await db.select().from(schema.clients).where(eq(schema.clients.organisationId, theirs.organisationId))).toHaveLength(1);
      expect(await db.select().from(schema.clients).where(eq(schema.clients.organisationId, mine.organisationId))).toHaveLength(2);
    });
  });
});

describe("reconcileStripe", () => {
  it("creates a client for a new subscription on a linked package, rings the owner, ignores unlinked products and is quiet when nothing changed", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const payments = mock(CATALOG, [sub({ id: "sub_a", customerId: "cus_a", customerName: "First Ltd", priceId: "price_basic", productId: "prod_basic" })]);
      await applyStripeSync(db, organisationId, payments, { selectedProductIds: ["prod_basic"] });
      expect(await notifications(db, organisationId)).toHaveLength(1);

      const quiet = await reconcileStripe(db, organisationId, payments);
      expect(quiet).toMatchObject({ trigger: "reconcile", subscriptions: { created: 0, updated: 0, unchanged: 1 }, statusChanges: [] });
      expect(await notifications(db, organisationId)).toHaveLength(1);

      payments.seedSubscriptions([
        sub({ id: "sub_a", customerId: "cus_a", customerName: "First Ltd", status: "past_due", providerStatus: "past_due", priceId: "price_basic", productId: "prod_basic" }),
        sub({ id: "sub_new", customerId: "cus_new", customerName: "new client ltd", priceId: "price_basic", productId: "prod_basic" }),
        sub({ id: "sub_starter", customerId: "cus_starter", customerName: "Unlinked", priceId: "price_starter", productId: "prod_starter" }),
      ]);
      const summary = await reconcileStripe(db, organisationId, payments);

      expect(summary.clients.created.map((c) => c.name)).toEqual(["New Client Ltd"]);
      expect(summary.subscriptions).toMatchObject({ created: 1, updated: 1 });
      expect(summary.statusChanges).toEqual([expect.objectContaining({ subscriptionId: "sub_a", clientName: "First Ltd", from: "active", to: "past_due" })]);
      expect((await getStripeSyncSettings(db, organisationId)).ignoredProductIds).toEqual(["prod_starter", "prod_cabio"]);
      expect((await db.select().from(schema.packages).where(eq(schema.packages.organisationId, organisationId))).map((p) => p.stripeProductId)).toEqual([null, "prod_basic"]);
      const bells = await notifications(db, organisationId);
      expect(bells).toHaveLength(2);
      expect(bells[1]!.title).toBe("New client from Stripe: New Client Ltd");
      const [first] = await db.select().from(schema.clients).where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, "First Ltd")));
      const timeline = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, first!.id));
      expect(timeline.map((t) => t.kind)).toContain("subscription.status_changed");
    });
  });
});

describe("syncFromPaymentsEvent — customer.subscription.*", () => {
  const eventObject = (over: Record<string, unknown> = {}) => ({
    id: "sub_hook", customer: "cus_hook", status: "active", created: 1_750_000_000, start_date: 1_750_000_000,
    current_period_start: null, current_period_end: null,
    items: { data: [{ quantity: 1, current_period_start: 1_756_684_800, current_period_end: 1_759_276_800, price: { id: "price_basic", product: "prod_basic", unit_amount: 5000, currency: "gbp" } }] },
    ...over,
  });

  it("provisions a client, billing profile and subscription for an unknown customer on a linked package and tells the owner", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const payments = mock(CATALOG, [sub({ id: "sub_hook", customerId: "cus_hook", customerEmail: "hook@example.test", customerName: "hooked ltd", priceId: "price_basic", productId: "prod_basic" })]);
      await db.insert(schema.packages).values({ organisationId, name: "Basic", slug: `basic-${randomUUID()}`, stripeProductId: "prod_basic" });

      const result = await syncFromPaymentsEvent(db, organisationId, {
        id: "evt_hook", type: "customer.subscription.created", data: { object: eventObject() },
      }, process.env, { payments });

      expect(result).toEqual({ handled: true, action: "subscription.provisioned" });
      const [client] = await db.select().from(schema.clients).where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, "Hooked Ltd")));
      expect(client).toMatchObject({ email: "hook@example.test" });
      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, client!.id));
      expect(profile!.stripeCustomerId).toBe("cus_hook");
      const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, "sub_hook"));
      expect(row).toMatchObject({ clientId: client!.id, status: "active", amountPence: 5000, stripePriceId: "price_basic", currentPeriodStart: new Date(1_756_684_800 * 1000) });
      const bells = await notifications(db, organisationId);
      expect(bells.map((b) => b.title)).toEqual(["New client from Stripe: Hooked Ltd"]);

      // The same event again: the subscription is known, nothing new is made.
      const again = await syncFromPaymentsEvent(db, organisationId, {
        id: "evt_hook_2", type: "customer.subscription.updated", data: { object: eventObject({ status: "past_due" }) },
      }, process.env, { payments });
      expect(again).toEqual({ handled: true, action: "subscription.past_due" });
      expect(await db.select().from(schema.clients).where(eq(schema.clients.organisationId, organisationId))).toHaveLength(2);
      expect((await notifications(db, organisationId)).map((b) => b.title)).toEqual(["New client from Stripe: Hooked Ltd", "Hooked Ltd: subscription past due"]);
    });
  });

  it("reports an unmapped price rather than importing it, and cancels a known subscription on deleted", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const unmapped = await syncFromPaymentsEvent(db, organisationId, {
        id: "evt_u", type: "customer.subscription.created", data: { object: eventObject() },
      });
      expect(unmapped).toEqual({ handled: false, action: "subscription.unmapped_price" });
      expect(await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.organisationId, organisationId))).toHaveLength(0);

      await db.insert(schema.subscriptions).values({
        organisationId, clientId, stripeSubscriptionId: "sub_hook", status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"), amountPence: 5000,
      });
      const deleted = await syncFromPaymentsEvent(db, organisationId, {
        id: "evt_d", type: "customer.subscription.deleted", data: { object: { id: "sub_hook", customer: "cus_hook", status: "canceled" } },
      });
      expect(deleted).toEqual({ handled: true, action: "subscription.cancelled" });
      const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, "sub_hook"));
      expect(row!.status).toBe("cancelled");
    });
  });
});
