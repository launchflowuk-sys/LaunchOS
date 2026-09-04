import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockPaymentsAdapter } from "@launchos/integrations";
import { createSubscription } from "./subscriptions.js";
import { nextInvoiceNumber } from "./invoice-number.js";
import { createInvoiceFromSubscription, markInvoicePaid, markInvoiceSent, voidInvoice } from "./invoices.js";

async function subscribed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `inv-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  await db.insert(schema.billingProfiles)
    .values({ organisationId: org!.id, clientId: client!.id, billingName: "Grays Ltd", paymentTermsDays: 14 });
  const [pkg] = await db.insert(schema.packages)
    .values({ organisationId: org!.id, name: "Growth", slug: `g-${randomUUID()}`, monthlyPricePence: 29900, setupPricePence: 0 }).returning();
  const { subscription } = await createSubscription(
    db, org!.id,
    { clientId: client!.id, packageId: pkg!.id, periodStart: new Date("2026-09-01T00:00:00Z") },
    new MockPaymentsAdapter(),
  );
  return { orgId: org!.id, clientId: client!.id, subscription };
}

describe("nextInvoiceNumber", () => {
  it("allocates sequential numbers per organisation and year", async () => {
    await withTestDb(async (db) => {
      const [a] = await db.insert(schema.organisations).values({ name: "A", slug: `a-${randomUUID()}` }).returning();
      const [b] = await db.insert(schema.organisations).values({ name: "B", slug: `b-${randomUUID()}` }).returning();
      expect(await nextInvoiceNumber(db, a!.id, 2026)).toBe("LF-2026-0001");
      expect(await nextInvoiceNumber(db, a!.id, 2026)).toBe("LF-2026-0002");
      expect(await nextInvoiceNumber(db, a!.id, 2027)).toBe("LF-2027-0001");
      expect(await nextInvoiceNumber(db, b!.id, 2026)).toBe("LF-2026-0001");
    });
  });
});

describe("createInvoiceFromSubscription", () => {
  it("bills the subscription period with VAT and the client's payment terms", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);

      const invoice = await createInvoiceFromSubscription(db, orgId, {
        subscriptionId: subscription.id, issuedAt: new Date("2026-09-01T00:00:00Z"), vatRatePercent: 20,
      });

      expect(invoice.number).toBe("LF-2026-0001");
      expect(invoice.status).toBe("draft");
      expect(invoice.subtotalPence).toBe(29900);
      expect(invoice.vatPence).toBe(5980);
      expect(invoice.totalPence).toBe(35880);
      expect(invoice.dueAt.toISOString()).toBe("2026-09-15T00:00:00.000Z");
      expect(invoice.lineItems).toHaveLength(1);
      expect(invoice.lineItems[0]!.unitPence).toBe(29900);
    });
  });

  it("moves a draft through sent to paid and records the audit trail", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);
      const invoice = await createInvoiceFromSubscription(db, orgId, { subscriptionId: subscription.id });

      const sent = await markInvoiceSent(db, orgId, { invoiceId: invoice.id, actorKind: "user", actorId: "u1" });
      expect(sent.status).toBe("sent");

      const paid = await markInvoicePaid(db, orgId, {
        invoiceId: invoice.id, paidAt: new Date("2026-09-10T00:00:00Z"), actorKind: "user", actorId: "u1",
      });
      expect(paid.status).toBe("paid");
      expect(paid.paidAt?.toISOString()).toBe("2026-09-10T00:00:00.000Z");

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, invoice.id));
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(["invoice.created", "invoice.sent", "invoice.paid"]),
      );
    });
  });

  it("refuses to void a paid invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);
      const invoice = await createInvoiceFromSubscription(db, orgId, { subscriptionId: subscription.id });
      await markInvoiceSent(db, orgId, { invoiceId: invoice.id });
      await markInvoicePaid(db, orgId, { invoiceId: invoice.id });
      await expect(voidInvoice(db, orgId, { invoiceId: invoice.id })).rejects.toThrow(/paid/i);
    });
  });

  it("refuses to pay a draft that was never sent", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);
      const invoice = await createInvoiceFromSubscription(db, orgId, { subscriptionId: subscription.id });

      await expect(markInvoicePaid(db, orgId, { invoiceId: invoice.id })).rejects.toThrow(/draft.*cannot be marked paid.*send it first/);

      const [unchanged] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(unchanged!.status).toBe("draft");
    });
  });

  it("treats paid and void as terminal", async () => {
    await withTestDb(async (db) => {
      const { orgId, subscription } = await subscribed(db);
      const paid = await createInvoiceFromSubscription(db, orgId, { subscriptionId: subscription.id });
      await markInvoiceSent(db, orgId, { invoiceId: paid.id });
      await markInvoicePaid(db, orgId, { invoiceId: paid.id });
      await expect(markInvoicePaid(db, orgId, { invoiceId: paid.id })).rejects.toThrow(/is paid and cannot be marked paid/);
      await expect(markInvoiceSent(db, orgId, { invoiceId: paid.id })).rejects.toThrow(/is paid and cannot be marked sent/);

      const voided = await createInvoiceFromSubscription(db, orgId, { subscriptionId: subscription.id });
      await voidInvoice(db, orgId, { invoiceId: voided.id });
      await expect(voidInvoice(db, orgId, { invoiceId: voided.id })).rejects.toThrow(/is void and cannot be marked void/);
      await expect(markInvoicePaid(db, orgId, { invoiceId: voided.id })).rejects.toThrow(/raise a new one/);
    });
  });
});
