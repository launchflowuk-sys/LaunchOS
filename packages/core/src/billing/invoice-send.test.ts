import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { requestInvoiceSend, sendApprovedInvoice } from "./invoice-send.js";

interface FixtureOptions {
  invoiceStatus?: "draft" | "sent" | "paid" | "void" | "overdue";
  clientEmail?: string | null;
}

async function fixture(db: Db, opts: FixtureOptions = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `snd-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "C", slug: `c-${randomUUID()}`,
    email: opts.clientEmail === undefined ? "client@example.test" : opts.clientEmail,
  }).returning();
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId: org!.id, clientId: client!.id, number: `LF-2026-${randomUUID().slice(0, 4)}`,
    status: opts.invoiceStatus ?? "draft", issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
    subtotalPence: 10000, vatPence: 2000, totalPence: 12000,
  }).returning();
  return { orgId: org!.id, clientId: client!.id, invoice: invoice! };
}

/** Requests a send and immediately decides it approved, as a human would in the admin portal. */
async function approvedInvoiceSend(db: Db, orgId: string, invoiceId: string) {
  const requested = await requestInvoiceSend(db, orgId, { invoiceId, actorId: "u1" });
  const [approved] = await db.update(schema.approvals)
    .set({ status: "approved", decidedBy: "u1", decidedAt: new Date() })
    .where(eq(schema.approvals.id, requested.id))
    .returning();
  return approved!;
}

describe("sendApprovedInvoice", () => {
  it("emails the client once and marks the invoice sent", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      const result = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test");

      expect(result).toEqual({ invoiceId: invoice.id, to: "client@example.test", alreadySent: false });
      expect(email.sent).toHaveLength(1);
      const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
      expect(after!.status).toBe("sent");
      expect(after!.metadata["sentApprovalId"]).toBe(approval.id);
    });
  });

  it("is a no-op on a second call for the same approval", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      const first = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test");
      const second = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test");

      expect(first.alreadySent).toBe(false);
      expect(second).toEqual({ invoiceId: invoice.id, to: "client@example.test", alreadySent: true });
      expect(email.sent).toHaveLength(1);
    });
  });

  it("throws when the approval is not an approved decision", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const pending = await requestInvoiceSend(db, orgId, { invoiceId: invoice.id, actorId: "u1" });
      const email = new MockEmailAdapter();

      await expect(
        sendApprovedInvoice(db, orgId, { approvalId: pending.id, actorId: "u1" }, email, "https://portal.test"),
      ).rejects.toThrow(/not an approved decision/);
      expect(email.sent).toHaveLength(0);
    });
  });

  it("refuses to send an invoice that is already paid", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db, { invoiceStatus: "paid" });
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      await expect(
        sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test"),
      ).rejects.toThrow(`invoice ${invoice.id} is paid`);
      expect(email.sent).toHaveLength(0);
    });
  });

  it("refuses to send a voided invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db, { invoiceStatus: "void" });
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      await expect(
        sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test"),
      ).rejects.toThrow(`invoice ${invoice.id} is void`);
      expect(email.sent).toHaveLength(0);
    });
  });

  it("throws when the client has no email address", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db, { clientEmail: null });
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      await expect(
        sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test"),
      ).rejects.toThrow(/has no email address/);
      expect(email.sent).toHaveLength(0);
    });
  });
});
