import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { createSubscription } from "./subscriptions.js";
import { createInvoiceFromSubscription, markInvoiceSent } from "./invoices.js";
import { findOverdueInvoices } from "./overdue.js";

describe("findOverdueInvoices", () => {
  it("flips a sent, past-due invoice to overdue, raises one billing ticket and notifies the owner", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `od-${randomUUID()}` }).returning();
      // notifyOwner delivers to the oldest active owner membership — the
      // fixture needs one on the books or the notification assertion below
      // has no recipient to land on.
      const [ownerUser] = await db.insert(schema.user)
        .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
      await db.insert(schema.organisationMembers)
        .values({ organisationId: org!.id, userId: ownerUser!.id, role: "owner", status: "active" });
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
      await db.insert(schema.billingProfiles).values({ organisationId: org!.id, clientId: client!.id, billingName: "Grays Ltd" });
      const [pkg] = await db.insert(schema.packages)
        .values({ organisationId: org!.id, name: "Growth", slug: `g-${randomUUID()}`, monthlyPricePence: 29900, setupPricePence: 0 }).returning();
      const { subscription } = await createSubscription(
        db, org!.id, { clientId: client!.id, packageId: pkg!.id, periodStart: new Date("2026-08-01T00:00:00Z") },
        new MockPaymentsAdapter(),
      );
      const invoice = await createInvoiceFromSubscription(db, org!.id, {
        subscriptionId: subscription.id, issuedAt: new Date("2026-08-01T00:00:00Z"),
      });
      await markInvoiceSent(db, org!.id, { invoiceId: invoice.id });

      const now = new Date("2026-09-04T07:30:00Z");
      const first = await findOverdueInvoices(db, org!.id, { now });
      expect(first).toHaveLength(1);
      expect(first[0]!.invoice.status).toBe("overdue");

      const tickets = await db.select().from(schema.tickets).where(and(
        eq(schema.tickets.organisationId, org!.id),
        eq(schema.tickets.category, "billing"),
      ));
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.subject).toContain(invoice.number);

      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org!.id));
      expect(notifications.length).toBeGreaterThan(0);

      // Idempotent: a second sweep neither re-flags nor re-tickets.
      expect(await findOverdueInvoices(db, org!.id, { now })).toHaveLength(0);
      const ticketsAgain = await db.select().from(schema.tickets).where(and(
        eq(schema.tickets.organisationId, org!.id),
        eq(schema.tickets.category, "billing"),
      ));
      expect(ticketsAgain).toHaveLength(1);
    });
  });

  it("ignores drafts, paid and voided invoices", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `od2-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
      const base = {
        organisationId: org!.id, clientId: client!.id,
        issuedAt: new Date("2026-08-01T00:00:00Z"), dueAt: new Date("2026-08-15T00:00:00Z"),
        subtotalPence: 100, vatPence: 20, totalPence: 120,
      };
      await db.insert(schema.invoices).values([
        { ...base, number: "LF-2026-9001", status: "draft" as const },
        { ...base, number: "LF-2026-9002", status: "paid" as const },
        { ...base, number: "LF-2026-9003", status: "void" as const },
      ]);
      expect(await findOverdueInvoices(db, org!.id, { now: new Date("2026-09-04T00:00:00Z") })).toHaveLength(0);
    });
  });
});
