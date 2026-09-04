import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { INVOICE_SEND_ACTION, requestInvoiceSend, RequestInvoiceSendInput } from "./invoice-send.js";
import { isSendableStatus } from "./invoices.js";
import { assertOwned } from "../tenancy/assert-owned.js";

type ApprovalRow = typeof schema.approvals.$inferSelect;

/**
 * The approvals row a queued send is parked in, if one is still waiting.
 *
 * An invoice send has no `runId` and no dedicated approval kind, so it is
 * identified the same way the invoice screen identifies it: by the `action`
 * and `invoiceId` keys of the payload.
 */
export async function findPendingInvoiceSendApproval(
  db: Db,
  organisationId: string,
  invoiceId: string,
): Promise<ApprovalRow | undefined> {
  const [approval] = await db
    .select()
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.status, "pending"),
      sql`${schema.approvals.payload}->>'action' = ${INVOICE_SEND_ACTION}`,
      sql`${schema.approvals.payload}->>'invoiceId' = ${invoiceId}`,
    ))
    .orderBy(asc(schema.approvals.createdAt))
    .limit(1);
  return approval;
}

/**
 * Queues an invoice send for approval, at most once per invoice.
 *
 * Without this, a replayed POST (or a second click on a screen whose banner has
 * not refreshed) files a second approval for the same invoice. Each one looks
 * actionable in the queue, and — because the send claim is per-approval —
 * approving both would email the client the same invoice twice. The existing
 * pending approval is returned instead, so the caller can point the user at the
 * decision that is already waiting rather than raising a duplicate.
 *
 * This is a check-then-insert rather than a database constraint, and it is a
 * **UX guard, not a safety guarantee.** The approvals table has no unique index
 * over a JSON payload key, so the losing side of a genuine race files a second
 * pending row — and because the send claim is per-approval, approving both of
 * them emails the client twice. There is no backstop underneath: `draft -> sent`,
 * `sent -> sent` and `overdue -> overdue` are all legal, so `sendApprovedInvoice`
 * has no reason to refuse the second one. If a real guarantee is wanted the
 * cheap one is a partial unique index on `(organisation_id, (payload->>'invoiceId'))`
 * where `status = 'pending' AND payload->>'action' = 'invoice_send'`; that is a
 * `packages/db` migration, deliberately deferred.
 *
 * The status check is done here rather than left to `requestInvoiceSend`: a
 * `paid` or `void` invoice must be refused even when a stale pending approval
 * exists, or the caller would be handed a decision it can never execute.
 */
export async function requestInvoiceSendOnce(
  db: Db,
  organisationId: string,
  input: RequestInvoiceSendInput,
): Promise<{ approval: ApprovalRow; alreadyPending: boolean }> {
  const v = RequestInvoiceSendInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
  if (!isSendableStatus(invoice!.status)) throw new Error(`invoice ${invoice!.id} is ${invoice!.status}`);

  const existing = await findPendingInvoiceSendApproval(db, organisationId, v.invoiceId);
  if (existing) return { approval: existing, alreadyPending: true };
  const approval = await requestInvoiceSend(db, organisationId, v);
  return { approval, alreadyPending: false };
}
