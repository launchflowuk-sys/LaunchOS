import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertInvoiceBelongsToClient, assertOwned } from "../tenancy/assert-owned.js";
import { markInvoicePaid } from "./invoices.js";

export const RecordPaymentInput = z.object({
  clientId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  amountPence: z.number().int(),
  currency: z.string().length(3).default("GBP"),
  provider: z.enum(["stripe", "bank", "cash", "other"]),
  providerRef: z.string().optional(),
  /**
   * Idempotency key for a hand-entered payment — a form nonce, a bank
   * statement line id, anything stable across a resubmit. Optional because
   * agent and webhook paths dedup on `providerRef` instead.
   */
  reference: z.string().min(1).max(200).optional(),
  status: z.enum(["pending", "succeeded", "failed", "refunded"]).default("succeeded"),
  paidAt: z.date().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type RecordPaymentInput = z.input<typeof RecordPaymentInput>;

/** Midnight UTC of the day `at` falls in — the window a `reference` dedups over. */
function startOfDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Insert, audit and reconciliation all land in one transaction: a payment row
 * that exists but was never audited, or one that settled the invoice without
 * itself being durable, would be a worse failure mode than the whole write
 * not having happened yet — so a throw at any step rolls all three back.
 *
 * When an invoice is named, its row is locked for the whole transaction. That
 * serialises two payments against the same invoice — both the duplicate check
 * and the reconciliation below — so a second payment can never compute a total
 * that excludes the first.
 *
 * `payments_org_provider_ref` cannot dedup a manual entry, because a bank or
 * cash payment usually has no `providerRef` and Postgres treats NULLs in a
 * unique index as distinct. A caller that can produce a stable key passes it as
 * `reference`; an exact repeat of the same invoice, amount and reference within
 * the same day is refused rather than silently double-counted. The window is
 * the UTC day the *entry is made*, not the day the payment landed: a resubmit
 * that straddles midnight, or a backdated `paidAt`, falls outside it. The
 * invoice row lock is what covers the double-click this was built for.
 */
export async function recordPayment(db: Db, organisationId: string, input: RecordPaymentInput) {
  const v = RecordPaymentInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.invoiceId) {
    await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
    // Same organisation is not enough: without this, a payment for client A
    // would settle client B's invoice.
    await assertInvoiceBelongsToClient(db, organisationId, v.invoiceId, v.clientId);
  }

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    if (v.invoiceId) {
      await tx.select({ id: schema.invoices.id }).from(schema.invoices)
        .where(and(eq(schema.invoices.id, v.invoiceId), eq(schema.invoices.organisationId, organisationId)))
        .for("update");
    }

    if (v.reference) {
      const duplicate = await findSameDayPayment(inner, organisationId, v.clientId, v.invoiceId, v.amountPence, v.reference);
      if (duplicate) {
        throw new Error(
          `a payment of £${(v.amountPence / 100).toFixed(2)} with reference "${v.reference}" was already recorded today (payment ${duplicate.id})`,
        );
      }
    }

    const [payment] = await tx.insert(schema.payments).values({
      organisationId,
      clientId: v.clientId,
      invoiceId: v.invoiceId ?? null,
      amountPence: v.amountPence,
      currency: v.currency,
      provider: v.provider,
      providerRef: v.providerRef ?? null,
      status: v.status,
      paidAt: v.paidAt ?? (v.status === "succeeded" ? new Date() : null),
      metadata: v.reference ? { reference: v.reference } : {},
    }).returning();
    await recordAudit(inner, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "payment.recorded",
      targetType: "payment", targetId: payment!.id, after: payment,
    });

    if (v.invoiceId) await reconcileInvoice(inner, organisationId, v.invoiceId, v.actorId);
    return payment!;
  });
}

/** An identical entry for the same client, invoice, amount and reference today. */
async function findSameDayPayment(
  db: Db,
  organisationId: string,
  clientId: string,
  invoiceId: string | undefined,
  amountPence: number,
  reference: string,
) {
  const [row] = await db.select({ id: schema.payments.id }).from(schema.payments).where(and(
    eq(schema.payments.organisationId, organisationId),
    eq(schema.payments.clientId, clientId),
    invoiceId ? eq(schema.payments.invoiceId, invoiceId) : isNull(schema.payments.invoiceId),
    eq(schema.payments.amountPence, amountPence),
    sql`${schema.payments.metadata}->>'reference' = ${reference}`,
    gte(schema.payments.createdAt, startOfDay(new Date())),
  )).limit(1);
  return row;
}

/** Why an invoice the payments cover was nonetheless not marked paid. */
export type ReconcileSkipReason = "underpaid" | "draft_not_issued" | "invoice_void";

export interface ReconcileInvoiceResult {
  paidPence: number;
  /** True only when the invoice is now `paid`. Never true for a skipped settle. */
  settled: boolean;
  reason?: ReconcileSkipReason;
}

/**
 * Sums the succeeded payments against an invoice and marks it paid once they
 * cover the total. Refunds and failures are excluded from the sum, so the money
 * on the invoice falls back below the total after a refund — but the invoice
 * itself is not un-paid automatically: reverting a settled invoice is a
 * deliberate, manual decision (void it, or raise a credit), never a side effect
 * of a webhook.
 *
 * `settled` means one thing only: **the invoice is now paid.** An invoice the
 * payments cover but that could not legally be settled comes back
 * `settled: false` with a `reason`, because reporting it as settled would tell
 * every caller — and every webhook log — that money was reconciled against an
 * invoice still sitting in `draft`.
 *
 * The invoice row is locked with `SELECT ... FOR UPDATE` before the sum. Under
 * READ COMMITTED a concurrent transaction's payment row is invisible to the
 * SUM, so without the lock two payments arriving together would each compute a
 * total excluding the other and leave a fully-paid invoice unsettled forever.
 * The transaction is opened here rather than assumed of the caller: outside one
 * the lock would be released the instant the SELECT returned. Drizzle turns the
 * nested case into a `SAVEPOINT`, so a caller that already holds a transaction
 * (`recordPayment`, `syncFromPaymentsEvent`) is unaffected and keeps the lock
 * to *its* commit.
 *
 * A `draft` or `void` invoice is never settled by this: neither was ever a live
 * demand on the client (`draft → paid` and `void → paid` are both illegal), so
 * the payment is recorded and the anomaly is raised — audit row, client
 * timeline, owner notification — instead of being swallowed. That flagging is
 * stamped as `metadata.settleSkippedAt` so a second payment against the same
 * invoice does not repeat it.
 */
export async function reconcileInvoice(
  db: Db,
  organisationId: string,
  invoiceId: string,
  actorId?: string,
): Promise<ReconcileInvoiceResult> {
  await assertOwned(db, organisationId, schema.invoices, invoiceId);
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [invoice] = await tx.select().from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.organisationId, organisationId)))
      .for("update");
    const rows = await tx.select({ amountPence: schema.payments.amountPence }).from(schema.payments).where(and(
      eq(schema.payments.organisationId, organisationId),
      eq(schema.payments.invoiceId, invoiceId),
      eq(schema.payments.status, "succeeded"),
    ));
    const paidPence = rows.reduce((sum, row) => sum + row.amountPence, 0);
    if (paidPence < invoice!.totalPence) return { paidPence, settled: false, reason: "underpaid" as const };

    if (invoice!.status === "sent" || invoice!.status === "overdue") {
      await markInvoicePaid(inner, organisationId, { invoiceId, actorKind: "system", actorId });
      return { paidPence, settled: true };
    }
    if (invoice!.status === "paid") return { paidPence, settled: true };

    const reason: ReconcileSkipReason = invoice!.status === "draft" ? "draft_not_issued" : "invoice_void";
    await flagSettleSkipped(inner, organisationId, invoice!, reason, actorId);
    return { paidPence, settled: false, reason };
  });
}

const SETTLE_SKIPPED_COPY: Record<"draft_not_issued" | "invoice_void", { title: string; body: string }> = {
  draft_not_issued: {
    title: "is paid in full but still a draft",
    body: "Send the invoice to mark it paid — a draft was never issued to the client.",
  },
  invoice_void: {
    title: "is void but has been paid in full",
    body: "Money has arrived against a cancelled invoice. Refund it or raise a replacement invoice.",
  },
};

/**
 * Money against an invoice that was never a live demand. Recorded four ways —
 * `metadata.settleSkippedAt`, an audit row, the client timeline and an owner
 * notification — because this is a same-day problem for whoever runs the books,
 * not a footnote. The stamp is also the guard: the second payment against the
 * same invoice finds it set and says nothing further.
 */
async function flagSettleSkipped(
  db: Db,
  organisationId: string,
  invoice: typeof schema.invoices.$inferSelect,
  reason: "draft_not_issued" | "invoice_void",
  actorId: string | undefined,
): Promise<void> {
  if (invoice.metadata["settleSkippedAt"] !== undefined) return;
  const copy = SETTLE_SKIPPED_COPY[reason];
  const [after] = await db.update(schema.invoices)
    .set({
      metadata: sql`coalesce(${schema.invoices.metadata}, '{}'::jsonb) || ${JSON.stringify({ settleSkippedAt: new Date().toISOString(), settleSkippedReason: reason })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.organisationId, organisationId)))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "system", actorId, action: "invoice.settle_skipped",
    targetType: "invoice", targetId: invoice.id, before: invoice, after,
  });
  await recordActivity(db, organisationId, {
    clientId: invoice.clientId, actorKind: "system", actorId, kind: "invoice.settle_skipped",
    title: `Invoice ${invoice.number} ${copy.title}`,
    body: copy.body,
    link: `/invoices/${invoice.id}`,
  });
  await notifyOwner(db, organisationId, {
    kind: "invoice.settle_skipped",
    title: `Invoice ${invoice.number} ${copy.title}`,
    body: copy.body,
    link: `/invoices/${invoice.id}`,
  });
}
