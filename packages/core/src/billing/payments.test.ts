import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { recordPayment, reconcileInvoice } from "./payments.js";

async function invoiced(db: Db, status: "draft" | "sent" | "overdue" = "sent") {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `pay-${randomUUID()}` }).returning();
  // notifyOwner delivers to the oldest active owner membership — the
  // settle-skipped test needs one to exist, same as overdue.test.ts.
  const [ownerUser] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId: org!.id, userId: ownerUser!.id, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: `LF-2026-${randomUUID().slice(0, 4)}`,
    status, issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000,
  }).returning();
  return { orgId: org!.id, clientId: client!.id, invoice: invoice! };
}

async function status(db: Db, invoiceId: string) {
  const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  return row!.status;
}

describe("recordPayment", () => {
  it("settles the invoice exactly when the succeeded payments cover the total", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);

      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 5000, provider: "bank",
        status: "succeeded", actorKind: "user", actorId: "u1",
      });
      expect(await status(db, invoice.id)).toBe("sent");

      // 5000 + 6999 is still short of the 12000 total.
      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 6999, provider: "bank",
        status: "succeeded", actorKind: "user", actorId: "u1",
      });
      expect(await status(db, invoice.id)).toBe("sent");

      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 1, provider: "bank",
        status: "succeeded", actorKind: "user", actorId: "u1",
      });
      const [settled] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(settled!.status).toBe("paid");
      expect(settled!.paidAt).not.toBeNull();
    });
  });

  it("settles an overdue invoice too", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db, "overdue");
      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 12000, provider: "bank" });
      expect(await status(db, invoice.id)).toBe("paid");
    });
  });

  it("leaves a fully-paid draft in draft, reports it as unsettled and tells the owner once", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db, "draft");
      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 12000, provider: "bank" });
      expect(await status(db, invoice.id)).toBe("draft");

      // `settled` must never claim an invoice was paid when it was not.
      const summary = await reconcileInvoice(db, orgId, invoice.id);
      expect(summary).toEqual({ paidPence: 12000, settled: false, reason: "draft_not_issued" });

      const events = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.clientId, clientId),
        eq(schema.activityEvents.kind, "invoice.settle_skipped"),
      ));
      expect(events).toHaveLength(1);

      // Money against an invoice that was never issued is a same-day problem.
      const notifications = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.organisationId, orgId),
        eq(schema.notifications.kind, "invoice.settle_skipped"),
      ));
      expect(notifications).toHaveLength(1);

      // A second payment must not repeat the flag.
      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 500, provider: "bank" });
      const again = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.clientId, clientId),
        eq(schema.activityEvents.kind, "invoice.settle_skipped"),
      ));
      expect(again).toHaveLength(1);
    });
  });

  it("refuses a payment whose invoice belongs to another client", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await invoiced(db);
      const [other] = await db.insert(schema.clients)
        .values({ organisationId: orgId, name: "Other", slug: `c-${randomUUID()}` }).returning();

      await expect(recordPayment(db, orgId, {
        clientId: other!.id, invoiceId: invoice.id, amountPence: 12000, provider: "bank",
      })).rejects.toThrow(/belongs to another client/);

      expect(await status(db, invoice.id)).toBe("sent");
      const rows = await db.select().from(schema.payments).where(eq(schema.payments.organisationId, orgId));
      expect(rows).toHaveLength(0);
    });
  });

  it("refuses an exact repeat of a referenced manual payment on the same day", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);
      const reference = `form-${randomUUID()}`;

      await recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 6000, provider: "cash", reference,
      });
      await expect(recordPayment(db, orgId, {
        clientId, invoiceId: invoice.id, amountPence: 6000, provider: "cash", reference,
      })).rejects.toThrow(/already recorded today/);

      const rows = await db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata["reference"]).toBe(reference);
    });
  });

  it("allows a genuine second payment under a different reference", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);

      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 6000, provider: "cash", reference: "a" });
      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 6000, provider: "cash", reference: "b" });

      expect(await status(db, invoice.id)).toBe("paid");
    });
  });

  it("ignores failed payments when reconciling", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await invoiced(db);
      await recordPayment(db, orgId, { clientId, invoiceId: invoice.id, amountPence: 12000, provider: "stripe", status: "failed" });
      const summary = await reconcileInvoice(db, orgId, invoice.id);
      expect(summary).toEqual({ paidPence: 0, settled: false, reason: "underpaid" });
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
