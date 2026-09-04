import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { findOrganisationByStripeCustomer, syncFromPaymentsEvent } from "./webhook-sync.js";

async function billed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `wh-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  // notifyOwner delivers to the oldest active owner membership — the failed-payment
  // test needs one to exist, same as overdue.test.ts.
  const [ownerUser] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId: org!.id, userId: ownerUser!.id, role: "owner", status: "active" });
  await db.insert(schema.billingProfiles)
    .values({ organisationId: org!.id, clientId: client!.id, billingName: "C Ltd", stripeCustomerId: "cus_live_1" });
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: "LF-2026-0001", status: "sent",
    issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000, stripeInvoiceId: "in_live_1",
  }).returning();
  return { orgId: org!.id, clientId: client!.id, invoice: invoice! };
}

describe("findOrganisationByStripeCustomer", () => {
  it("resolves the organisation and client from a customer id", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await billed(db);
      expect(await findOrganisationByStripeCustomer(db, "cus_live_1")).toEqual({ organisationId: orgId, clientId });
      expect(await findOrganisationByStripeCustomer(db, "cus_unknown")).toBeUndefined();
    });
  });
});

describe("syncFromPaymentsEvent", () => {
  it("records a succeeded payment and settles the invoice on invoice.paid", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await billed(db);

      const result = await syncFromPaymentsEvent(db, orgId, {
        id: "evt_1", type: "invoice.paid",
        data: { object: { id: "in_live_1", customer: "cus_live_1", amount_paid: 12000, currency: "gbp" } },
      });

      expect(result).toEqual({ handled: true, action: "invoice.paid" });
      const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(after!.status).toBe("paid");
      const payments = await db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      expect(payments).toHaveLength(1);
      expect(payments[0]!.provider).toBe("stripe");
      expect(payments[0]!.providerRef).toBe("evt_1");
    });
  });

  it("is idempotent for a repeated event id", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await billed(db);
      const event = {
        id: "evt_1", type: "invoice.paid",
        data: { object: { id: "in_live_1", customer: "cus_live_1", amount_paid: 12000, currency: "gbp" } },
      };
      await syncFromPaymentsEvent(db, orgId, event);
      const repeat = await syncFromPaymentsEvent(db, orgId, event);
      expect(repeat.handled).toBe(false);
      const payments = await db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      expect(payments).toHaveLength(1);
    });
  });

  it("records a failed payment and notifies the owner on invoice.payment_failed", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await billed(db);

      const result = await syncFromPaymentsEvent(db, orgId, {
        id: "evt_2", type: "invoice.payment_failed",
        data: { object: { id: "in_live_1", customer: "cus_live_1", amount_due: 12000, currency: "gbp" } },
      });

      expect(result.action).toBe("payment.failed");
      const payments = await db.select().from(schema.payments).where(eq(schema.payments.organisationId, orgId));
      expect(payments[0]!.status).toBe("failed");
      const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, orgId));
      expect(notifications.length).toBeGreaterThan(0);
    });
  });

  it("updates the local subscription status on customer.subscription.updated", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await billed(db);
      const [sub] = await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId, stripeSubscriptionId: "sub_live_1", status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
        amountPence: 12000,
      }).returning();

      await syncFromPaymentsEvent(db, orgId, {
        id: "evt_3", type: "customer.subscription.updated",
        data: { object: { id: "sub_live_1", customer: "cus_live_1", status: "past_due" } },
      });

      const [after] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, sub!.id));
      expect(after!.status).toBe("past_due");
    });
  });

  it("ignores an event type it does not handle", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await billed(db);
      const result = await syncFromPaymentsEvent(db, orgId, { id: "evt_9", type: "customer.created", data: {} });
      expect(result).toEqual({ handled: false, action: "ignored" });
    });
  });
});
