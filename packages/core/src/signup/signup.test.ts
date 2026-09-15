import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { MockEmailAdapter } from "@launchos/channels";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { syncFromPaymentsEvent } from "../billing/webhook-sync.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { checkoutOrganisationFromEvent } from "../billing/webhook-sync.js";
import { completeSignup, createSignupSession, priceMismatchReason, SignupRefused } from "./signup.js";
import type { PaymentsPrice } from "@launchos/integrations";

afterEach(() => setEnqueue(async () => {}));

const env = { APP_URL: "https://os.test", MAIL_FROM: "LaunchFlow <hello@launchflow.test>" } as NodeJS.ProcessEnv;

async function seed(db: Db, stripePriceId: string | null) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `signup-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  const [pkg] = await db.insert(schema.packages).values({
    organisationId: org!.id, name: "Growth", slug: "growth", monthlyPricePence: 14900, stripePriceId,
    includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  }).returning();
  return { orgId: org!.id, ownerId, pkg: pkg! };
}

const buyer = { packageSlug: "growth", email: "Aisha@KhanDental.test", name: "Aisha Khan", business: "Khan Dental", phone: "0770" };

describe("createSignupSession", () => {
  it("with a Stripe price: writes a lead, opens Checkout with our metadata, and records the session on the lead", async () => {
    await withTestDb(async (db) => {
      const { orgId, pkg } = await seed(db, "price_growth");
      const payments = new MockPaymentsAdapter();
      const result = await createSignupSession(db, orgId, buyer, { payments }, env);
      expect(result.mode).toBe("checkout");
      if (result.mode !== "checkout") return;
      expect(result.url).toBe(`https://os.test/signup/done?session_id=${result.sessionId}`);
      const session = await payments.retrieveCheckoutSession(result.sessionId);
      expect(session.metadata).toMatchObject({ launchos: "signup", organisationId: orgId, packageId: pkg.id, leadId: result.leadId, email: "aisha@khandental.test", business: "Khan Dental" });
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, result.leadId));
      expect(lead).toMatchObject({ source: "signup", status: "new", email: "aisha@khandental.test" });
      expect(lead!.metadata["checkoutSessionId"]).toBe(result.sessionId);
      // No owner bell yet — the buyer may abandon; the bell comes at completion.
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, orgId))).toHaveLength(0);
    });
  });

  it("stores the attribution the buyer arrived with on the signup lead", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seed(db, "price_growth");
      const attribution = { utmSource: "google", utmMedium: "cpc", utmCampaign: "spring-launch", gclid: "abc123", landingPath: "/signup?package=growth" };
      const result = await createSignupSession(db, orgId, { ...buyer, attribution }, { payments: new MockPaymentsAdapter() }, env);
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, result.leadId));
      expect(lead!.metadata["attribution"]).toEqual(attribution);
      // The package stamp is still there beside it.
      expect(lead!.metadata["packageSlug"]).toBe("growth");
    });
  });

  it("refuses an unknown or inactive package", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seed(db, null);
      const refused = await createSignupSession(db, orgId, { ...buyer, packageSlug: "nope" }, { payments: new MockPaymentsAdapter() }, env).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(SignupRefused);
      expect((refused as SignupRefused).reason).toBe("unknown_package");
    });
  });

  it("without a Stripe price: provisions client, subscription, first invoice, portal login and welcome email straight away", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, pkg } = await seed(db, null);
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const email = new MockEmailAdapter();
      const result = await createSignupSession(db, orgId, buyer, { payments: new MockPaymentsAdapter(), email }, env);
      expect(result.mode).toBe("invoice");
      if (result.mode !== "invoice") return;

      const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, result.clientId));
      expect(client).toMatchObject({ name: "Khan Dental", email: "aisha@khandental.test", phone: "0770", packageId: pkg.id, organisationId: orgId });
      const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, result.subscriptionId));
      expect(subscription).toMatchObject({ clientId: result.clientId, status: "active", amountPence: 14900 });
      const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, result.invoiceId!));
      expect(invoice).toMatchObject({ clientId: result.clientId, status: "sent", subtotalPence: 14900 });
      const [portal] = await db.select().from(schema.clientUsers).where(and(eq(schema.clientUsers.clientId, result.clientId), eq(schema.clientUsers.userId, result.portalUserId!)));
      expect(portal?.role).toBe("client_admin");
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, result.leadId));
      expect(lead).toMatchObject({ status: "converted", clientId: result.clientId });
      expect(result.url).toBe(`https://os.test/signup/done?client=${result.clientId}`);

      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]).toMatchObject({ to: "aisha@khandental.test", from: "LaunchFlow <hello@launchflow.test>", subject: "Welcome to LaunchFlow — your portal login" });
      expect(email.sent[0]!.text).toContain("temporary password");
      expect(email.sent[0]!.text).toContain(`https://os.test/portal/invoices/${result.invoiceId}`);
      // The password is in the email and nowhere in the database.
      const password = /temporary password (\S+)\./.exec(email.sent[0]!.text)![1]!;
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, orgId));
      expect(JSON.stringify(messages)).not.toContain(password);

      const [bell] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ownerId), eq(schema.notifications.kind, "signup.completed")));
      expect(bell?.title).toBe("New client signed up: Khan Dental (Growth)");
      expect(events.map((e) => e.name)).toContain("client.created");
      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.action, "signup.completed")));
      expect(audits).toHaveLength(1);
    });
  });
});

describe("completeSignup", () => {
  it("provisions once from a paid session, answers alreadyCompleted after, and links the Stripe ids", async () => {
    await withTestDb(async (db) => {
      const { orgId, pkg } = await seed(db, "price_growth");
      const payments = new MockPaymentsAdapter();
      const email = new MockEmailAdapter();
      const started = await createSignupSession(db, orgId, buyer, { payments }, env);
      if (started.mode !== "checkout") throw new Error("expected checkout");
      const open = await payments.retrieveCheckoutSession(started.sessionId);
      const notPaid = await completeSignup(db, orgId, { session: { ...open, status: "open", paymentStatus: "unpaid" } }, { email }, env).catch((e: unknown) => e);
      expect((notPaid as SignupRefused).reason).toBe("not_paid");

      const paid = await payments.retrieveCheckoutSession(started.sessionId);
      const first = await completeSignup(db, orgId, { session: paid }, { email }, env);
      expect(first.alreadyCompleted).toBe(false);
      expect(first.clientId).toBeTruthy();
      expect(first.portalUserId).toBeTruthy();
      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, first.clientId!));
      expect(profile?.stripeCustomerId).toBe(paid.customerId);
      const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, first.subscriptionId!));
      expect(subscription).toMatchObject({ stripeSubscriptionId: paid.subscriptionId, packageId: pkg.id, status: "active", amountPence: 14900 });
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]!.text).not.toContain("invoice is ready");

      const again = await completeSignup(db, orgId, { session: paid }, { email }, env);
      expect(again).toMatchObject({ alreadyCompleted: true, clientId: first.clientId, subscriptionId: first.subscriptionId, leadId: started.leadId });
      expect(email.sent).toHaveLength(1);
      expect(await db.select().from(schema.clients).where(eq(schema.clients.organisationId, orgId))).toHaveLength(1);
    });
  });

  it("refuses a session that is not ours or belongs to another organisation, and makes the lead when none exists", async () => {
    await withTestDb(async (db) => {
      const a = await seed(db, "price_growth");
      const b = await seed(db, "price_growth");
      const payments = new MockPaymentsAdapter();
      const foreign = payments.completeCheckout("mock_cs_x", { metadata: {} });
      expect(((await completeSignup(db, a.orgId, { session: foreign }, {}, env).catch((e: unknown) => e)) as SignupRefused).reason).toBe("not_a_signup");

      const session = payments.completeCheckout("mock_cs_y", {
        metadata: { launchos: "signup", organisationId: b.orgId, packageId: b.pkg.id, email: "x@y.test", name: "X", business: "X Ltd" },
      });
      expect(((await completeSignup(db, a.orgId, { session }, {}, env).catch((e: unknown) => e)) as SignupRefused).reason).toBe("wrong_organisation");
      const done = await completeSignup(db, b.orgId, { session }, { email: new MockEmailAdapter() }, env);
      expect(done.alreadyCompleted).toBe(false);
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, done.leadId));
      expect(lead).toMatchObject({ organisationId: b.orgId, source: "signup", status: "converted", clientId: done.clientId });
    });
  });

  it("is reached from the Stripe webhook through syncFromPaymentsEvent, and the route can find the organisation from the event", async () => {
    await withTestDb(async (db) => {
      const { orgId, pkg } = await seed(db, "price_growth");
      const event = {
        id: "evt_1", type: "checkout.session.completed",
        data: { object: {
          id: "cs_live_1", status: "complete", payment_status: "paid", customer: "cus_1", subscription: "sub_1",
          customer_details: { email: "aisha@khandental.test" },
          metadata: { launchos: "signup", organisationId: orgId, packageId: pkg.id, email: "aisha@khandental.test", name: "Aisha", business: "Khan Dental" },
        } },
      };
      expect(checkoutOrganisationFromEvent(event)).toBe(orgId);
      expect(checkoutOrganisationFromEvent({ id: "evt_2", type: "invoice.paid", data: { object: { metadata: event.data.object.metadata } } })).toBeNull();

      const first = await syncFromPaymentsEvent(db, orgId, event, { ...env, EMAIL_ADAPTER: "mock" });
      expect(first).toEqual({ handled: true, action: "signup.completed" });
      const again = await syncFromPaymentsEvent(db, orgId, event, { ...env, EMAIL_ADAPTER: "mock" });
      expect(again).toEqual({ handled: true, action: "signup.duplicate" });
      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.stripeCustomerId, "cus_1"));
      expect(profile?.organisationId).toBe(orgId);
      const other = await seed(db, null);
      expect(await syncFromPaymentsEvent(db, other.orgId, event, env)).toEqual({ handled: false, action: "signup.wrong_organisation" });
    });
  });
});

/**
 * The guard on what a package will actually charge.
 *
 * These are the only checks standing between a mistyped `stripe_price_id` and
 * a customer's card, so each wrong shape gets its own case and each asserts
 * the *message* as well as the refusal — the message is the whole value, since
 * the person reading it is whoever has to go and fix the price.
 */
describe("priceMismatchReason", () => {
  const pkg = { name: "Standard", monthlyPricePence: 11_000, setupPricePence: 0, currency: "GBP" };
  const good: PaymentsPrice = {
    priceId: "price_std", amountPence: 11_000, currency: "GBP", interval: "month", intervalCount: 1,
    priceActive: true, productName: "Standard", productActive: true,
  };

  it("passes a price that matches", () => {
    expect(priceMismatchReason(good, pkg)).toBeNull();
  });

  /**
   * The live trap: an archived "Standard Plan" at £45 with a working Stripe
   * price sits beside the active "Standard" at £110. Paste the wrong one and
   * every buyer is charged £45 while the invoice still says £110.
   */
  it("catches the wrong amount and names both figures", () => {
    const reason = priceMismatchReason({ ...good, amountPence: 4_500, productName: "Standard Plan" }, pkg);
    expect(reason).toContain("£110.00");
    expect(reason).toContain("£45.00");
    expect(reason).toContain("Standard Plan");
  });

  it("catches a yearly price sold as a monthly plan", () => {
    expect(priceMismatchReason({ ...good, interval: "year" }, pkg)).toMatch(/every 1 year/);
  });

  it("catches a quarterly price", () => {
    expect(priceMismatchReason({ ...good, intervalCount: 3 }, pkg)).toMatch(/every 3 month/);
  });

  it("catches a one-off price, which cannot back a subscription", () => {
    expect(priceMismatchReason({ ...good, interval: null, intervalCount: 0 }, pkg)).toMatch(/one-off/);
  });

  it("catches the wrong currency", () => {
    expect(priceMismatchReason({ ...good, currency: "USD" }, pkg)).toMatch(/GBP.*USD/);
  });

  it("catches an archived price and an archived product separately", () => {
    expect(priceMismatchReason({ ...good, priceActive: false }, pkg)).toMatch(/archived/);
    expect(priceMismatchReason({ ...good, productActive: false }, pkg)).toMatch(/archived/);
  });
});

describe("createSignupSession price guard", () => {
  /** A stub rather than the mock: the mock's prices are invented, so only a stub can disagree on purpose. */
  function stubPayments(price: PaymentsPrice | null, overrides: Partial<{ throws: boolean }> = {}) {
    const mock = new MockPaymentsAdapter();
    return Object.assign(Object.create(Object.getPrototypeOf(mock)), mock, {
      name: "stripe" as const,
      retrievePrice: async () => {
        if (overrides.throws) throw new Error("stripe is down");
        return price;
      },
    });
  }
  const priceFor = (amountPence: number): PaymentsPrice => ({
    priceId: "price_growth", amountPence, currency: "GBP", interval: "month", intervalCount: 1,
    priceActive: true, productName: "Growth", productActive: true,
  });

  it("refuses before a session exists when the amount disagrees", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seed(db, "price_growth");
      // The package is £149; the Stripe price would charge £45.
      const payments = stubPayments(priceFor(4_500));
      await expect(createSignupSession(db, orgId, buyer, { payments }, env)).rejects.toMatchObject({
        name: "SignupRefused", reason: "price_mismatch",
      });
      // Nothing was opened, so nobody was sent anywhere to pay.
      expect(await db.select().from(schema.leads).where(eq(schema.leads.organisationId, orgId))).toHaveLength(1);
    });
  });

  it("refuses a price Stripe no longer has", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seed(db, "price_gone");
      await expect(createSignupSession(db, orgId, buyer, { payments: stubPayments(null) }, env)).rejects.toMatchObject({
        reason: "price_mismatch",
      });
    });
  });

  it("opens Checkout when the price agrees", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seed(db, "price_growth");
      const result = await createSignupSession(db, orgId, buyer, { payments: stubPayments(priceFor(14_900)) }, env);
      expect(result.mode).toBe("checkout");
    });
  });

  /**
   * An outage is not a misconfiguration. If the price cannot be read the
   * signup proceeds, because the very next call is to the same API and fails
   * on its own if Stripe is genuinely down — while a wrong price id is still
   * wrong on the next attempt and gets caught then.
   */
  it("proceeds when the price cannot be checked at all", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seed(db, "price_growth");
      const result = await createSignupSession(db, orgId, buyer, { payments: stubPayments(null, { throws: true }) }, env);
      expect(result.mode).toBe("checkout");
    });
  });

  /**
   * Checkout here is subscription-only: it subscribes to the monthly price and
   * never charges `setup_price_pence`. Selling such a package this way would
   * silently collect nothing for the setup.
   */
  it("refuses a package with a setup fee, which Checkout would never collect", async () => {
    await withTestDb(async (db) => {
      const { orgId, pkg } = await seed(db, "price_growth");
      await db.update(schema.packages).set({ setupPricePence: 50_000 }).where(eq(schema.packages.id, pkg.id));
      await expect(
        createSignupSession(db, orgId, buyer, { payments: stubPayments(priceFor(14_900)) }, env),
      ).rejects.toMatchObject({ reason: "price_mismatch" });
    });
  });

  /** The mock has no real prices, so there is nothing to verify and local signups must still work. */
  it("does not check the mock adapter", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seed(db, "price_nothing_the_mock_knows");
      const result = await createSignupSession(db, orgId, buyer, { payments: new MockPaymentsAdapter() }, env);
      expect(result.mode).toBe("checkout");
    });
  });
});
