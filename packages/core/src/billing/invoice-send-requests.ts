import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { INVOICE_SEND_ACTION, requestInvoiceSend, RequestInvoiceSendInput } from "./invoice-send.js";
import { isSendableStatus } from "./invoices.js";
import { assertOwned } from "../tenancy/assert-owned.js";

type ApprovalRow = typeof schema.approvals.$inferSelect;

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** The partial unique index in `packages/db/src/schema/agents.ts` that backs the guarantee below. */
export const PENDING_INVOICE_SEND_INDEX = "approvals_pending_invoice_send";

/**
 * True when `error` is the index above refusing a second pending send request.
 *
 * Matched by constraint name rather than by error code alone: any other unique
 * index on `approvals` firing here would be a different bug, and swallowing it
 * as "already pending" would return an approval that has nothing to do with
 * this invoice.
 *
 * Drizzle wraps a driver failure in a `DrizzleQueryError` whose `message` is
 * the SQL, and hangs the real `PostgresError` off `cause` — so the chain is
 * walked rather than only the thrown object inspected. Exported so a test can
 * prove the driver really does report the field and the name this matches on:
 * get that wrong and the recovery below never runs, and a race surfaces to the
 * operator as a raw Postgres error instead.
 */
export function isPendingSendCollision(error: unknown): boolean {
  for (let node: unknown = error, depth = 0; node !== null && node !== undefined && depth < 5; depth += 1) {
    if (typeof node !== "object") return false;
    const candidate = node as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    // postgres-js exposes `constraint_name`; the driver-agnostic `constraint`
    // is checked too so this does not silently stop working behind another
    // client. Both must line up with a unique violation — any other index on
    // `approvals` firing here is a different bug.
    if (
      candidate.code === UNIQUE_VIOLATION &&
      (candidate.constraint_name === PENDING_INVOICE_SEND_INDEX || candidate.constraint === PENDING_INVOICE_SEND_INDEX)
    ) {
      return true;
    }
    node = candidate.cause;
  }
  return false;
}

/**
 * The approvals row a queued send is parked in, if one is still waiting.
 *
 * An invoice send has no `runId` and no dedicated approval kind, so it is
 * identified the same way the invoice screen identifies it: by the `action`
 * and `invoiceId` keys of the payload. The predicate is deliberately the same
 * one the partial unique index uses, so this read and that index can never
 * disagree about what "pending send for this invoice" means.
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
      eq(schema.approvals.kind, "message_send"),
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
 * **The guarantee is the database's, not this function's.** The partial unique
 * index `approvals_pending_invoice_send` — unique on
 * `(organisation_id, payload->>'invoiceId')` where the row is a *pending*
 * `message_send` whose `payload->>'action'` is `invoice_send` — is what makes
 * "at most one pending send per invoice" true. The read below is only a fast
 * path that keeps the common case free of a rolled-back INSERT; the loser of a
 * genuine race gets a `23505` from the index and is answered from the row that
 * won, so both callers are handed the same approval and neither files a
 * second. Nothing downstream would catch a duplicate: `draft -> sent`,
 * `sent -> sent` and `overdue -> overdue` are all legal, so `sendApprovedInvoice`
 * has no reason to refuse the second one.
 *
 * The index is partial so a decided approval stops occupying the slot: a
 * resend, or the next overdue chase, files a fresh request exactly as an
 * operator expects.
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

  try {
    // Wrapped so the losing insert rolls back on its own: at the top level this
    // is an ordinary transaction, and inside a caller's transaction drizzle
    // issues a SAVEPOINT. Either way the recovery SELECT below runs on a
    // connection that is not in an aborted transaction — without the savepoint,
    // a nested caller would get "current transaction is aborted" instead of the
    // approval it asked for. It also makes the approval row and its audit row
    // one unit, which they were not before.
    const approval = await db.transaction(async (tx) => requestInvoiceSend(tx as unknown as Db, organisationId, v));
    return { approval, alreadyPending: false };
  } catch (error) {
    if (!isPendingSendCollision(error)) throw error;
    // The winner committed between our read and our insert. Its row is the
    // decision that is now waiting, so return that rather than the error.
    const winner = await findPendingInvoiceSendApproval(db, organisationId, v.invoiceId);
    if (!winner) throw error;
    return { approval: winner, alreadyPending: true };
  }
}
