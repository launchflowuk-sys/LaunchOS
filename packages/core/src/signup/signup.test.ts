import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { MockEmailAdapter } from "@launchos/channels";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { syncFromPaymentsEvent } from "../billing/webhook-sync.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { completeSignup, createSignupSession, SignupRefused, signupOrganisationFromEvent } from "./signup.js";

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
      expect(signupOrganisationFromEvent(event)).toBe(orgId);
      expect(signupOrganisationFromEvent({ id: "evt_2", type: "invoice.paid", data: { object: { metadata: event.data.object.metadata } } })).toBeNull();

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
