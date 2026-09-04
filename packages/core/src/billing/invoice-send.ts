import type { EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { supportEmailFor } from "../config.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { markInvoiceSent } from "./invoices.js";

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

/**
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
): Promise<{ invoiceId: string; to: string }> {
  const v = SendApprovedInvoiceInput.parse(input);
  const [approval] = await db.select().from(schema.approvals).where(and(
    eq(schema.approvals.id, v.approvalId),
    eq(schema.approvals.organisationId, organisationId),
    eq(schema.approvals.status, "approved"),
  ));
  if (!approval) throw new Error(`approval ${v.approvalId} is not an approved decision in this organisation`);

  const payload = z.object({ action: z.literal(INVOICE_SEND_ACTION), invoiceId: z.string().uuid() }).parse(approval.payload);
  const [invoice] = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.id, payload.invoiceId),
    eq(schema.invoices.organisationId, organisationId),
  ));
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, invoice!.clientId));
  const to = client!.email;
  if (!to) throw new Error(`client ${client!.id} has no email address to send invoice ${invoice!.number} to`);

  const link = `${portalBaseUrl}/portal/invoices/${invoice!.id}`;
  const amount = `£${(invoice!.totalPence / 100).toFixed(2)}`;
  const from = env.MAIL_FROM ?? supportEmailFor("invoices", env);
  await email.send({
    to,
    from,
    subject: `Invoice ${invoice!.number} from LaunchFlow`,
    text: `Hello ${client!.name},\n\nInvoice ${invoice!.number} for ${amount} is ready. You can view and print it here:\n${link}\n\nIt is due on ${invoice!.dueAt.toISOString().slice(0, 10)}.\n\nThank you,\nLaunchFlow`,
  });

  await markInvoiceSent(db, organisationId, { invoiceId: invoice!.id, actorKind: "user", actorId: v.actorId });
  await recordActivity(db, organisationId, {
    clientId: invoice!.clientId, actorKind: "user", actorId: v.actorId, kind: "invoice.sent",
    title: `Invoice ${invoice!.number} emailed to ${to}`, link: `/invoices/${invoice!.id}`,
  });
  return { invoiceId: invoice!.id, to };
}
