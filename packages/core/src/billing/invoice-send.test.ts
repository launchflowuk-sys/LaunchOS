import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import type { EmailAdapter, SendResult } from "@launchos/channels";
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

/** An email provider that is down. The claim has already committed when it throws. */
class FailingEmailAdapter implements EmailAdapter {
  readonly name = "mock" as const;
  attempts = 0;
  async send(): Promise<SendResult> {
    this.attempts += 1;
    throw new Error("smtp: connection refused");
  }
}

async function reload(db: Db, invoiceId: string) {
  const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  return row!;
}

function sendHistory(invoice: typeof schema.invoices.$inferSelect): { approvalId: string }[] {
  return (invoice.metadata["sendHistory"] as { approvalId: string }[] | undefined) ?? [];
}

describe("requestInvoiceSend", () => {
  it("refuses to raise an approval for a paid invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db, { invoiceStatus: "paid" });
      await expect(requestInvoiceSend(db, orgId, { invoiceId: invoice.id, actorId: "u1" }))
        .rejects.toThrow(`invoice ${invoice.id} is paid`);
    });
  });

  it("refuses to raise an approval for a void invoice", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db, { invoiceStatus: "void" });
      await expect(requestInvoiceSend(db, orgId, { invoiceId: invoice.id, actorId: "u1" }))
        .rejects.toThrow(`invoice ${invoice.id} is void`);
    });
  });
});

describe("sendApprovedInvoice", () => {
  it("emails the client once and marks the invoice sent", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      const result = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test");

      expect(result).toEqual({ invoiceId: invoice.id, to: "client@example.test", alreadySent: false });
      expect(email.sent).toHaveLength(1);
      const after = await reload(db, invoice.id);
      expect(after.status).toBe("sent");
      expect(after.metadata["sentApprovalId"]).toBe(approval.id);
      expect(sendHistory(after).map((e) => e.approvalId)).toEqual([approval.id]);
    });
  });

  it("consumes the approval, so a second call with it sends nothing", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      const first = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test");
      const second = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test");

      expect(first.alreadySent).toBe(false);
      expect(second).toEqual({ invoiceId: invoice.id, to: "client@example.test", alreadySent: true });
      expect(email.sent).toHaveLength(1);

      const [consumed] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(consumed!.metadata["consumedAt"]).toEqual(expect.any(String));
      expect(consumed!.metadata["invoiceId"]).toBe(invoice.id);
      expect(sendHistory(await reload(db, invoice.id))).toHaveLength(1);
    });
  });

  it("sends again for a second approval — a resend is not a no-op", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const email = new MockEmailAdapter();

      const first = await approvedInvoiceSend(db, orgId, invoice.id);
      await sendApprovedInvoice(db, orgId, { approvalId: first.id, actorId: "u1" }, email, "https://portal.test");
      const second = await approvedInvoiceSend(db, orgId, invoice.id);
      const result = await sendApprovedInvoice(db, orgId, { approvalId: second.id, actorId: "u1" }, email, "https://portal.test");

      expect(result.alreadySent).toBe(false);
      expect(email.sent).toHaveLength(2);
      const after = await reload(db, invoice.id);
      expect(after.metadata["sentApprovalId"]).toBe(second.id);
      expect(sendHistory(after).map((e) => e.approvalId)).toEqual([first.id, second.id]);
    });
  });

  it("chases an overdue invoice on a fresh approval", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db, { invoiceStatus: "overdue" });
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const email = new MockEmailAdapter();

      const result = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test");

      expect(result.alreadySent).toBe(false);
      expect(email.sent).toHaveLength(1);
      expect((await reload(db, invoice.id)).status).toBe("sent");
    });
  });

  it("keeps the claim when the email throws, records the failure and refuses a retry on the same approval", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, invoice } = await fixture(db);
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      const failing = new FailingEmailAdapter();

      await expect(
        sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, failing, "https://portal.test"),
      ).rejects.toThrow(/connection refused/);

      // The claim is deliberately not rolled back: rolling it back would re-arm
      // a second email for the same approval.
      const after = await reload(db, invoice.id);
      expect(after.status).toBe("sent");
      expect((after.metadata["lastSendError"] as { message: string }).message).toBe("smtp: connection refused");

      const activity = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.clientId, clientId),
        eq(schema.activityEvents.kind, "invoice.send_failed"),
      ));
      expect(activity).toHaveLength(1);

      // A retry with the spent approval must not reach the adapter at all.
      const retry = await sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, failing, "https://portal.test");
      expect(retry.alreadySent).toBe(true);
      expect(failing.attempts).toBe(1);
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

  it("refuses to send an invoice that was paid after the approval was raised", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      await db.update(schema.invoices).set({ status: "paid" }).where(eq(schema.invoices.id, invoice.id));
      const email = new MockEmailAdapter();

      await expect(
        sendApprovedInvoice(db, orgId, { approvalId: approval.id, actorId: "u1" }, email, "https://portal.test"),
      ).rejects.toThrow(`invoice ${invoice.id} is paid`);
      expect(email.sent).toHaveLength(0);
      // The refusal rolled the claim back, so the approval is still actionable.
      const [untouched] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(untouched!.metadata["consumedAt"]).toBeUndefined();
    });
  });

  it("refuses to send an invoice that was voided after the approval was raised", async () => {
    await withTestDb(async (db) => {
      const { orgId, invoice } = await fixture(db);
      const approval = await approvedInvoiceSend(db, orgId, invoice.id);
      await db.update(schema.invoices).set({ status: "void" }).where(eq(schema.invoices.id, invoice.id));
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
