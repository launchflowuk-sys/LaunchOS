import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { markInvoicePaid } from "./invoices.js";

export const RecordPaymentInput = z.object({
  clientId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  amountPence: z.number().int(),
  currency: z.string().length(3).default("GBP"),
  provider: z.enum(["stripe", "bank", "cash", "other"]),
  providerRef: z.string().optional(),
  status: z.enum(["pending", "succeeded", "failed", "refunded"]).default("succeeded"),
  paidAt: z.date().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type RecordPaymentInput = z.input<typeof RecordPaymentInput>;

export async function recordPayment(db: Db, organisationId: string, input: RecordPaymentInput) {
  const v = RecordPaymentInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.invoiceId) await assertOwned(db, organisationId, schema.invoices, v.invoiceId);

  const [payment] = await db.insert(schema.payments).values({
    organisationId,
    clientId: v.clientId,
    invoiceId: v.invoiceId ?? null,
    amountPence: v.amountPence,
    currency: v.currency,
    provider: v.provider,
    providerRef: v.providerRef ?? null,
    status: v.status,
    paidAt: v.paidAt ?? (v.status === "succeeded" ? new Date() : null),
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "payment.recorded",
    targetType: "payment", targetId: payment!.id, after: payment,
  });

  if (v.invoiceId) await reconcileInvoice(db, organisationId, v.invoiceId, v.actorId);
  return payment!;
}

/**
 * Sums the succeeded payments against an invoice and marks it paid once they
 * cover the total. Refunds and failures are excluded, so a refunded invoice
 * naturally falls back below its total and is no longer treated as settled.
 */
export async function reconcileInvoice(
  db: Db,
  organisationId: string,
  invoiceId: string,
  actorId?: string,
): Promise<{ paidPence: number; settled: boolean }> {
  await assertOwned(db, organisationId, schema.invoices, invoiceId);
  const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  const rows = await db.select({ amountPence: schema.payments.amountPence }).from(schema.payments).where(and(
    eq(schema.payments.organisationId, organisationId),
    eq(schema.payments.invoiceId, invoiceId),
    eq(schema.payments.status, "succeeded"),
  ));
  const paidPence = rows.reduce((sum, row) => sum + row.amountPence, 0);
  const settled = paidPence >= invoice!.totalPence;
  if (settled && invoice!.status !== "paid" && invoice!.status !== "void") {
    await markInvoicePaid(db, organisationId, { invoiceId, actorKind: "system", actorId });
  }
  return { paidPence, settled };
}
