import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { requestInvoiceSend } from "./invoice-send.js";
import {
  findPendingInvoiceSendApproval, isPendingSendCollision, PENDING_INVOICE_SEND_INDEX, requestInvoiceSendOnce,
} from "./invoice-send-requests.js";

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

describe("approvals_pending_invoice_send", () => {
  it("is the database, not the read, that refuses a second pending send for one invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      // `requestInvoiceSend` is the unguarded insert — no pre-read — so this is
      // exactly what the loser of a race executes.
      await requestInvoiceSend(db, orgId, { invoiceId: invoice.id, actorId: "u1" });

      // Savepointed so the expected violation does not abort the test's own
      // transaction, the same way requestInvoiceSendOnce savepoints its insert.
      const error = await db
        .transaction(async (tx) => requestInvoiceSend(tx as unknown as Db, orgId, { invoiceId: invoice.id, actorId: "u2" }))
        .then(() => undefined, (e: unknown) => e);

      expect(error).toBeDefined();
      // Drizzle wraps the driver failure; the PostgresError is on `cause`.
      const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
      expect(cause?.code).toBe("23505");
      expect(cause?.constraint_name).toBe(PENDING_INVOICE_SEND_INDEX);
      // The matcher the recovery path depends on has to recognise it, or a race
      // reaches the operator as a raw Postgres error.
      expect(isPendingSendCollision(error)).toBe(true);
    });
  });

  it("frees the slot once the approval is decided, and never constrains a different invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const first = await requestInvoiceSend(db, orgId, { invoiceId: invoice.id, actorId: "u1" });
      await db.update(schema.approvals).set({ status: "approved", decidedAt: new Date(), decidedBy: "u1" })
        .where(eq(schema.approvals.id, first.id));

      // Same invoice, previous request decided: a resend is allowed.
      await expect(requestInvoiceSend(db, orgId, { invoiceId: invoice.id, actorId: "u1" })).resolves.toBeDefined();

      // A pending approval that is not an invoice send is outside the index
      // entirely, however many of them share an organisation.
      const runless = {
        organisationId: orgId, kind: "message_send" as const, title: "Reply to a client",
        payload: { action: "reply", conversationId: randomUUID() },
      };
      await db.insert(schema.approvals).values(runless);
      await expect(db.insert(schema.approvals).values(runless)).resolves.toBeDefined();
    });
  });

  it("recovers the winner's approval when the index refuses the racing insert", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const winner = await requestInvoiceSend(db, orgId, { invoiceId: invoice.id, actorId: "u1" });

      // The fast-path read finds the winner here, so drive the recovery branch
      // directly: the insert collides, and the caller is answered from the row
      // that won rather than with a 23505.
      const collision = await db
        .transaction(async (tx) => requestInvoiceSend(tx as unknown as Db, orgId, { invoiceId: invoice.id, actorId: "u2" }))
        .then(() => undefined, (e: unknown) => e);
      expect(isPendingSendCollision(collision)).toBe(true);
      expect((await findPendingInvoiceSendApproval(db, orgId, invoice.id))?.id).toBe(winner.id);

      const second = await requestInvoiceSendOnce(db, orgId, { invoiceId: invoice.id, actorId: "u2" });
      expect(second).toEqual({ approval: expect.objectContaining({ id: winner.id }), alreadyPending: true });
      const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, orgId));
      expect(rows).toHaveLength(1);
    });
  });

  it("does not treat an unrelated unique violation as an already-pending send", () => {
    expect(isPendingSendCollision({ code: "23505", constraint_name: "approvals_something_else" })).toBe(false);
    expect(isPendingSendCollision({ code: "23503", constraint_name: PENDING_INVOICE_SEND_INDEX })).toBe(false);
    expect(isPendingSendCollision(new Error("boom"))).toBe(false);
    expect(isPendingSendCollision(undefined)).toBe(false);
    // A wrapped violation still counts; a wrapped unrelated one still does not.
    expect(isPendingSendCollision({ cause: { code: "23505", constraint_name: PENDING_INVOICE_SEND_INDEX } })).toBe(true);
    expect(isPendingSendCollision({ cause: { code: "23505", constraint_name: "invoices_org_number" } })).toBe(false);
  });
});
