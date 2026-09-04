import type { EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailFor } from "../config.js";
import { assertOwned } from "../tenancy/assert-owned.js";

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
 */
export async function requestInvoiceSend(db: Db, organisationId: string, input: RequestInvoiceSendInput) {
  const v = RequestInvoiceSendInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
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

const INVOICE_UNCLAIMED_STATUSES = ["draft", "sent"] as const;

/**
 * A staff member sending an approved invoice by hand. This is a human action,
 * audited rather than queued — the approval gate is what raised it in the
 * first place (`requestInvoiceSend`).
 *
 * The metadata flag is the claim: `UPDATE ... WHERE (metadata->>'sentApprovalId')
 * IS NULL` inside a transaction takes the invoice only if no approval has
 * claimed it yet, so two concurrent calls for the same approval (or a retry
 * racing the first attempt) cannot both pass and email the client twice. An
 * invoice already claimed is not an error — it returns `alreadySent: true` so
 * a caller (a doubled button click, an approval-resume path) can treat it as
 * a no-op. The email send happens *after* the claim but still inside the same
 * transaction: if it throws — bad address, provider outage — the whole
 * transaction rolls back, so the invoice reverts to its prior status rather
 * than being stuck `sent` with no mail actually delivered, and a retry can
 * claim it again.
 *
 * A `paid` or `void` invoice is refused outright rather than silently
 * no-opped: those are terminal states a send should never happen against,
 * unlike "already sent", which is a normal, retry-safe outcome.
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
): Promise<{ invoiceId: string; to: string; alreadySent: boolean }> {
  const v = SendApprovedInvoiceInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.status, "approved")));
  if (!approval) throw new Error(`approval ${v.approvalId} is not an approved decision in this organisation`);

  const payload = z.object({ action: z.literal(INVOICE_SEND_ACTION), invoiceId: z.string().uuid() }).parse(approval.payload);
  await assertOwned(db, organisationId, schema.invoices, payload.invoiceId);

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, payload.invoiceId));
    if (before!.status === "paid" || before!.status === "void") {
      throw new Error(`invoice ${before!.id} is ${before!.status}`);
    }

    // See the doc comment: the metadata guard is the atomic claim, resolved
    // by Postgres inside this single UPDATE rather than a separate
    // SELECT-then-UPDATE that would leave a race window.
    const [claimed] = await tx.update(schema.invoices)
      .set({
        status: "sent",
        metadata: sql`coalesce(${schema.invoices.metadata}, '{}'::jsonb) || ${JSON.stringify({ sentApprovalId: v.approvalId })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.invoices.id, payload.invoiceId),
        eq(schema.invoices.organisationId, organisationId),
        inArray(schema.invoices.status, INVOICE_UNCLAIMED_STATUSES),
        sql`(${schema.invoices.metadata}->>'sentApprovalId') IS NULL`,
      ))
      .returning();

    const [client] = await tx.select().from(schema.clients).where(eq(schema.clients.id, before!.clientId));
    const to = client?.email ?? "";

    if (!claimed) return { invoiceId: before!.id, to, alreadySent: true };
    if (!to) throw new Error(`client ${client!.id} has no email address to send invoice ${claimed.number} to`);

    const link = `${portalBaseUrl}/portal/invoices/${claimed.id}`;
    const amount = `£${(claimed.totalPence / 100).toFixed(2)}`;
    const from = env.MAIL_FROM ?? supportEmailFor("invoices", env);
    await email.send({
      to,
      from,
      subject: `Invoice ${claimed.number} from LaunchFlow`,
      text: `Hello ${client!.name},\n\nInvoice ${claimed.number} for ${amount} is ready. You can view and print it here:\n${link}\n\nIt is due on ${claimed.dueAt.toISOString().slice(0, 10)}.\n\nThank you,\nLaunchFlow`,
    });

    await recordAudit(inner, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "invoice.sent",
      targetType: "invoice", targetId: claimed.id, before, after: claimed,
    });
    await recordActivity(inner, organisationId, {
      clientId: claimed.clientId, actorKind: "user", actorId: v.actorId, kind: "invoice.sent",
      title: `Invoice ${claimed.number} emailed to ${to}`, link: `/invoices/${claimed.id}`,
    });
    return { invoiceId: claimed.id, to, alreadySent: false };
  });
}
