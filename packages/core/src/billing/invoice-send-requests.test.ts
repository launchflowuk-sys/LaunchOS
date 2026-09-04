import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { findPendingInvoiceSendApproval, requestInvoiceSendOnce } from "./invoice-send-requests.js";

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `req-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "C", slug: `c-${randomUUID()}`, email: "client@example.test",
  }).returning();
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: `LF-2026-${randomUUID().slice(0, 4)}`,
    status: "draft", issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000,
  }).returning();
  return { orgId: org!.id, invoice: invoice! };
}

describe("requestInvoiceSendOnce", () => {
  it("queues one approval and returns the same one on a replayed request", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);

      const first = await requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u1" });
      const second = await requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u1" });

      expect(first.alreadyPending).toBe(false);
      expect(second.alreadyPending).toBe(true);
      expect(second.approval.id).toBe(first.approval.id);
      const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, orgId));
      expect(rows).toHaveLength(1);
    });
  });

  it("queues a fresh approval once the previous one has been decided", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const first = await requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u1" });
      await db.update(schema.approvals).set({ status: "rejected", decidedAt: new Date(), decidedBy: "u1" })
        .where(eq(schema.approvals.id, first.approval.id));

      const second = await requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u1" });

      expect(second.alreadyPending).toBe(false);
      expect(second.approval.id).not.toBe(first.approval.id);
    });
  });

  it("does not see another invoice's queued send", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      await requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u1" });

      expect(await findPendingInvoiceSendApproval(db, orgId, randomUUID())).toBeUndefined();
      expect((await findPendingInvoiceSendApproval(db, orgId, invoice.id))?.payload["invoiceId"]).toBe(invoice.id);
    });
  });

  it("refuses a terminal invoice even when a stale pending approval exists", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      await requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u1" });
      // The invoice is settled while its send approval is still queued.
      await db.update(schema.invoices).set({ status: "paid" }).where(eq(schema.invoices.id, invoice.id));

      // Handing back the stale decision would be handing back one that can
      // never be executed, so the status is checked before the pending lookup.
      await expect(requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u1" }))
        .rejects.toThrow(`invoice ${invoice.id} is paid`);
    });
  });

  it("refuses an invoice from another organisation", async () => {
    await withTestDb(async (db) => {
      const { invoice } = await fixture(db);
      const [other] = await db.insert(schema.organisations)
        .values({ name: "Other", slug: `req-${randomUUID()}` }).returning();

      await expect(requestInvoiceSendOnce(db, other!.id, { invoiceId: invoice.id, actorId: "u1" }))
        .rejects.toThrow(/not found in organisation/);
    });
  });
});
