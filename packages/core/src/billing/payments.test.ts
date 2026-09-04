import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { recordPayment, reconcileInvoice } from "./payments.js";

async function invoiced(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `pay-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: `LF-2026-${randomUUID().slice(0, 4)}`,
    status: "sent", issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000,
  }).returning();
  return { orgId: org!.id, clientId: client!.id, invoice: invoice! };
}

describe("recordPayment", () => {
  it("settles the invoice when the succeeded payments cover the total", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);

      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 5000, provider: "bank",
        status: "succeeded", actorKind: "user", actorId: "u1",
      });
      const [partly] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(partly!.status).toBe("sent");

      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 7000, provider: "bank",
        status: "succeeded", actorKind: "user", actorId: "u1",
      });
      const [settled] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(settled!.status).toBe("paid");
      expect(settled!.paidAt).not.toBeNull();
    });
  });

  it("ignores failed payments when reconciling", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);
      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 12000, provider: "stripe", status: "failed" });
      const summary = await reconcileInvoice(db, orgId, invoice.id);
      expect(summary).toEqual({ paidPence: 0, settled: false });
    });
  });

  it("records a payment with no invoice attached", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await invoiced(db);
      const payment = await recordPayment(db, orgId, { clientId, amountPence: 2500, provider: "cash", status: "succeeded" });
      expect(payment.invoiceId).toBeNull();
      expect(payment.currency).toBe("GBP");
    });
  });
});
