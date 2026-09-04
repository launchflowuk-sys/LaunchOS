import type { EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailFor } from "../config.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { isSendableStatus, sendTargetStatus } from "./invoices.js";

/** Marks an approvals row as an invoice send rather than an agent tool call. */
export const INVOICE_SEND_ACTION = "invoice_send";

export const RequestInvoiceSendInput = z.object({
  invoiceId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type RequestInvoiceSendInput = z.input<typeof RequestInvoiceSendInput>;

/**
 * Emailing a client is outward-facing, so it goes through the same approvals
 * queue an agent tool would use — with no run id, because a human raised it.
 *
 * A `paid` or `void` invoice is refused here rather than at execution time: an
 * approval a human can never act on is worse than no approval at all.
 */
export async function requestInvoiceSend(db: Db, organisationId: string, input: RequestInvoiceSendInput) {
  const v = RequestInvoiceSendInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
  if (!isSendableStatus(invoice!.status)) throw new Error(`invoice ${invoice!.id} is ${invoice!.status}`);

  const [client] = await db.select({ name: schema.clients.name })
    .from(schema.clients).where(eq(schema.clients.id, invoice!.clientId));

  const [approval] = await db.insert(schema.approvals).values({
    organisationId,
    kind: "message_send",
    title: `Send invoice ${invoice!.number} to ${client?.name ?? "the client"}`,
    payload: { action: INVOICE_SEND_ACTION, invoiceId: v.invoiceId, clientId: invoice!.clientId },
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "invoice.send_requested",
    targetType: "invoice", targetId: v.invoiceId, after: approval,
  });
  return approval!;
}

export const SendApprovedInvoiceInput = z.object({
  approvalId: z.string().uuid(),
  actorId: z.string().min(1),
});
export type SendApprovedInvoiceInput = z.input<typeof SendApprovedInvoiceInput>;

export interface SendApprovedInvoiceResult {
  invoiceId: string;
  to: string;
  alreadySent: boolean;
}

/**
 * Executes an invoice send that a human has already approved.
 *
 * **The guarantee is: at most one email per approval.** The claim is the
 * approval row, not the invoice — one `UPDATE approvals SET metadata =
 * metadata || {consumedAt, invoiceId} WHERE id = ? AND status = 'approved' AND
 * (metadata->>'consumedAt') IS NULL RETURNING *`. Only one caller can flip
 * `consumedAt` from null, so a doubled button click or a retry racing the first
 * attempt cannot both pass. An approval that is already consumed is not an
 * error — it returns `alreadySent: true` and touches nothing. Because the claim
 * is per-approval, a *new* approval sends the same invoice again: resends and
 * overdue chases work exactly as an operator expects.
 *
 * The email is sent **after** the transaction commits, never inside it. The
 * claim, the invoice transition, the audit row and the activity row are durable
 * before a single byte reaches the mail provider, and the claim is *not* rolled
 * back when the send fails — rolling it back would re-arm a second email for
 * the same approval, which is precisely what this function exists to prevent.
 * So: a failed send needs a fresh approval. The failure is recorded rather than
 * hidden — an `invoice.send_failed` activity, an owner notification and
 * `metadata.lastSendError` on the invoice — and the error is rethrown.
 *
 * A `paid` or `void` invoice is refused outright: those are terminal states a
 * send should never happen against, unlike "already sent for this approval",
 * which is a normal, retry-safe outcome. An `overdue` invoice stays `overdue` —
 * chasing a debt does not un-overdue it, and resetting it to `sent` would hand
 * it straight back to the overdue sweep as a fresh, unflagged arrear.
 *
 * `metadata.sentAt` is the first send; `metadata.emailedAt` is written in a
 * second, small transaction once the provider has actually accepted the
 * message. An invoice with a `sentAt` and no `emailedAt` more than a few
 * minutes old is therefore a one-line query for "claimed but never confirmed
 * delivered" — the state a crash between COMMIT and `email.send()` leaves
 * behind, which is otherwise indistinguishable from a successful send.
 *
 * `env` follows the same convention as `sendAdReport`/`sendQueuedMessage`: the
 * envelope sender is the verified `MAIL_FROM` when set, falling back to an
 * `invoices@<SUPPORT_EMAIL_DOMAIN>` identity so tests and local dev work unset.
 */
export async function sendApprovedInvoice(
  db: Db,
  organisationId: string,
  input: SendApprovedInvoiceInput,
  email: EmailAdapter,
  portalBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SendApprovedInvoiceResult> {
  const v = SendApprovedInvoiceInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.status, "approved")));
  if (!approval) throw new Error(`approval ${v.approvalId} is not an approved decision in this organisation`);

  const payload = z.object({ action: z.literal(INVOICE_SEND_ACTION), invoiceId: z.string().uuid() }).parse(approval.payload);
  await assertOwned(db, organisationId, schema.invoices, payload.invoiceId);

  const claim = await claimApproval(db, organisationId, v.approvalId, payload.invoiceId, v.actorId);
  if (!claim) {
    const to = await clientEmailForInvoice(db, organisationId, payload.invoiceId);
    return { invoiceId: payload.invoiceId, to, alreadySent: true };
  }

  const { invoice, clientName, to } = claim;
  const link = `${portalBaseUrl}/portal/invoices/${invoice.id}`;
  const amount = `£${(invoice.totalPence / 100).toFixed(2)}`;
  const from = env.MAIL_FROM ?? supportEmailFor("invoices", env);

  try {
    await email.send({
      to,
      from,
      subject: `Invoice ${invoice.number} from LaunchFlow`,
      text: `Hello ${clientName},\n\nInvoice ${invoice.number} for ${amount} is ready. You can view and print it here:\n${link}\n\nIt is due on ${invoice.dueAt.toISOString().slice(0, 10)}.\n\nThank you,\nLaunchFlow`,
    });
  } catch (error) {
    await recordSendFailure(db, organisationId, invoice, v.approvalId, to, error).catch((bookkeeping: unknown) => {
      throw new AggregateError([error, bookkeeping], `invoice ${invoice.number} failed to send and the failure could not be recorded`);
    });
    throw error;
  }

  await confirmSend(db, organisationId, invoice.id, v.approvalId);
  return { invoiceId: invoice.id, to, alreadySent: false };
}

/**
 * Stamps `metadata.emailedAt` now the provider has taken the message. Failing
 * to write it is deliberately not fatal: the email has already gone, so
 * throwing here would tell the operator the send failed and invite a second
 * one. The invoice simply keeps the "sent but unconfirmed" shape a crash at
 * this point would leave — which is exactly what the field exists to represent.
 */
async function confirmSend(db: Db, organisationId: string, invoiceId: string, approvalId: string): Promise<void> {
  const confirmation = { emailedAt: new Date().toISOString(), emailedApprovalId: approvalId };
  await db.update(schema.invoices)
    .set({
      metadata: sql`coalesce(${schema.invoices.metadata}, '{}'::jsonb) || ${JSON.stringify(confirmation)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.organisationId, organisationId)))
    .catch(() => undefined);
}

interface InvoiceClaim {
  invoice: typeof schema.invoices.$inferSelect;
  clientName: string;
  to: string;
}

/**
 * Consumes the approval and transitions the invoice, or returns undefined when
 * this approval has already been consumed. Everything here commits together:
 * the claim is never durable without the transition it authorises, and neither
 * is durable without its audit and activity rows.
 */
async function claimApproval(
  db: Db,
  organisationId: string,
  approvalId: string,
  invoiceId: string,
  actorId: string,
): Promise<InvoiceClaim | undefined> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [consumed] = await tx.update(schema.approvals)
      .set({
        metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify({ consumedAt: now.toISOString(), invoiceId })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.approvals.id, approvalId),
        eq(schema.approvals.organisationId, organisationId),
        eq(schema.approvals.status, "approved"),
        sql`(${schema.approvals.metadata}->>'consumedAt') IS NULL`,
      ))
      .returning();
    if (!consumed) return undefined;

    // The row lock serialises this transition against a concurrent
    // reconciliation, so a send cannot overwrite a `paid` that landed between
    // the read and the write.
    const [before] = await tx.select().from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.organisationId, organisationId)))
      .for("update");
    if (!before) throw new Error(`invoice ${invoiceId} not found in organisation`);
    if (!isSendableStatus(before.status)) throw new Error(`invoice ${before.id} is ${before.status}`);

    const [client] = await tx.select().from(schema.clients).where(eq(schema.clients.id, before.clientId));
    const to = client?.email ?? "";
    if (!to) throw new Error(`client ${before.clientId} has no email address to send invoice ${before.number} to`);

    const historyEntry = JSON.stringify({ approvalId, at: now.toISOString(), actorId });
    // `sentAt` is the date the client first received this invoice, so a resend
    // or a chase must not move it — `sendHistory` is where every send lands.
    // Read under the same `FOR UPDATE` lock as the write, so no concurrent send
    // can slip its own first-send stamp in between.
    const firstSend = before.metadata["sentAt"] === undefined;
    const stamp = firstSend
      ? { sentAt: now.toISOString(), sentApprovalId: approvalId }
      : { sentApprovalId: approvalId };
    const [after] = await tx.update(schema.invoices)
      .set({
        status: sendTargetStatus(before.status),
        // `sendHistory` is append-only: every approval that ever emailed this
        // invoice stays on the record, so a resend is auditable without a
        // second table.
        metadata: sql`coalesce(${schema.invoices.metadata}, '{}'::jsonb)
          || ${JSON.stringify(stamp)}::jsonb
          || jsonb_build_object('sendHistory', coalesce(${schema.invoices.metadata}->'sendHistory', '[]'::jsonb) || ${historyEntry}::jsonb)`,
        updatedAt: now,
      })
      .where(eq(schema.invoices.id, before.id))
      .returning();

    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId, action: "invoice.sent",
      targetType: "invoice", targetId: after!.id, before, after,
    });
    await recordActivity(inner, organisationId, {
      clientId: after!.clientId, actorKind: "user", actorId, kind: "invoice.sent",
      // "queued", not "emailed": this row commits before the provider is
      // called, so it can only honestly claim the send was authorised and
      // handed on. `metadata.emailedAt` is the confirmation.
      title: `Invoice ${after!.number} queued to ${to}`, link: `/invoices/${after!.id}`,
    });
    return { invoice: after!, clientName: client!.name, to };
  });
}

/**
 * The address the invoice would have gone to, for the already-sent report. A
 * missing join row is a broken invoice/client reference, not "sent to nobody",
 * so it throws exactly as the send path does rather than the two disagreeing
 * about the same condition. A client row that simply has no email address
 * still reports the empty string: nothing is broken, there is just no address.
 */
async function clientEmailForInvoice(db: Db, organisationId: string, invoiceId: string): Promise<string> {
  const [row] = await db.select({ email: schema.clients.email })
    .from(schema.invoices)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.invoices.clientId))
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.organisationId, organisationId)));
  if (!row) throw new Error(`invoice ${invoiceId} has no client in organisation ${organisationId}`);
  return row.email ?? "";
}

/**
 * A send that failed after the claim committed. The claim stays taken on
 * purpose (see the `sendApprovedInvoice` doc comment), so this is what makes
 * the gap visible: the invoice carries a `lastSendError` and no `emailedAt`,
 * the client timeline says the email did not go, and the owner is told.
 */
async function recordSendFailure(
  db: Db,
  organisationId: string,
  invoice: typeof schema.invoices.$inferSelect,
  approvalId: string,
  to: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const lastSendError = { at: new Date().toISOString(), approvalId, to, message };
  await db.update(schema.invoices)
    .set({
      metadata: sql`coalesce(${schema.invoices.metadata}, '{}'::jsonb) || ${JSON.stringify({ lastSendError })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.invoices.id, invoice.id), eq(schema.invoices.organisationId, organisationId)));
  await recordActivity(db, organisationId, {
    clientId: invoice.clientId, actorKind: "system", kind: "invoice.send_failed",
    title: `Invoice ${invoice.number} was not emailed to ${to}`,
    body: `${message}\n\nThe approval is spent. Request a new send to try again.`,
    link: `/invoices/${invoice.id}`,
  });
  await notifyOwner(db, organisationId, {
    kind: "invoice.send_failed",
    title: `Invoice ${invoice.number} was not emailed`,
    body: `Sending to ${to} failed: ${message}. The approval is spent — request a new send to try again.`,
    link: `/invoices/${invoice.id}`,
  });
}
