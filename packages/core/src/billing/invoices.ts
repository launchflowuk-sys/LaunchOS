import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { InvoiceLineItem } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { nextInvoiceNumber } from "./invoice-number.js";

export const VAT_RATE_DEFAULT_PERCENT = 20;
export const PAYMENT_TERMS_DEFAULT_DAYS = 14;

const ActorKind = z.enum(["user", "client", "agent", "system"]);
type ActorKind = z.infer<typeof ActorKind>;

export const CreateInvoiceFromSubscriptionInput = z.object({
  subscriptionId: z.string().uuid(),
  issuedAt: z.date().optional(),
  vatRatePercent: z.number().min(0).max(100).default(VAT_RATE_DEFAULT_PERCENT),
  termsDays: z.number().int().min(0).optional(),
  actorKind: ActorKind.default("system"),
  actorId: z.string().optional(),
});
export type CreateInvoiceFromSubscriptionInput = z.input<typeof CreateInvoiceFromSubscriptionInput>;

export async function createInvoiceFromSubscription(db: Db, organisationId: string, input: CreateInvoiceFromSubscriptionInput) {
  const v = CreateInvoiceFromSubscriptionInput.parse(input);
  await assertOwned(db, organisationId, schema.subscriptions, v.subscriptionId);

  const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, v.subscriptionId));
  const [pkg] = subscription!.packageId
    ? await db.select().from(schema.packages).where(eq(schema.packages.id, subscription!.packageId))
    : [undefined];
  const [profile] = await db.select().from(schema.billingProfiles).where(and(
    eq(schema.billingProfiles.organisationId, organisationId),
    eq(schema.billingProfiles.clientId, subscription!.clientId),
  ));

  const issuedAt = v.issuedAt ?? subscription!.currentPeriodStart;
  const termsDays = v.termsDays ?? profile?.paymentTermsDays ?? PAYMENT_TERMS_DEFAULT_DAYS;
  const dueAt = new Date(issuedAt.getTime() + termsDays * 86_400_000);
  const subtotalPence = subscription!.amountPence;
  const vatPence = Math.round((subtotalPence * v.vatRatePercent) / 100);
  const lineItems: InvoiceLineItem[] = [{
    description: `${pkg?.name ?? "Monthly retainer"} — ${issuedAt.toISOString().slice(0, 7)}`,
    quantity: 1,
    unitPence: subtotalPence,
  }];

  const invoice = await db.transaction(async (tx) => {
    const number = await nextInvoiceNumber(tx as unknown as Db, organisationId, issuedAt.getUTCFullYear());
    const [row] = await tx.insert(schema.invoices).values({
      organisationId,
      clientId: subscription!.clientId,
      subscriptionId: subscription!.id,
      number,
      issuedAt,
      dueAt,
      subtotalPence,
      vatPence,
      totalPence: subtotalPence + vatPence,
      currency: subscription!.currency,
      lineItems,
    }).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "invoice.created",
      targetType: "invoice", targetId: row!.id, after: row,
    });
    return row!;
  });

  await recordActivity(db, organisationId, {
    clientId: invoice.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "invoice.created",
    title: `Invoice ${invoice.number} raised`,
    body: `£${(invoice.totalPence / 100).toFixed(2)} due ${invoice.dueAt.toISOString().slice(0, 10)}.`,
    link: `/invoices/${invoice.id}`,
  });
  return invoice;
}

const InvoiceActionInput = z.object({
  invoiceId: z.string().uuid(),
  actorKind: ActorKind.default("system"),
  actorId: z.string().optional(),
});

async function transition(
  db: Db,
  organisationId: string,
  invoiceId: string,
  action: string,
  patch: Partial<typeof schema.invoices.$inferInsert>,
  actorKind: ActorKind,
  actorId: string | undefined,
) {
  await assertOwned(db, organisationId, schema.invoices, invoiceId);
  const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  const [after] = await db.update(schema.invoices)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.invoices.id, invoiceId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind, actorId, action, targetType: "invoice", targetId: invoiceId, before, after,
  });
  return after!;
}

export async function markInvoiceSent(db: Db, organisationId: string, input: z.input<typeof InvoiceActionInput>) {
  const v = InvoiceActionInput.parse(input);
  return transition(db, organisationId, v.invoiceId, "invoice.sent", { status: "sent" }, v.actorKind, v.actorId);
}

export const MarkInvoicePaidInput = InvoiceActionInput.extend({ paidAt: z.date().optional() });
export type MarkInvoicePaidInput = z.input<typeof MarkInvoicePaidInput>;

export async function markInvoicePaid(db: Db, organisationId: string, input: MarkInvoicePaidInput) {
  const v = MarkInvoicePaidInput.parse(input);
  return transition(
    db, organisationId, v.invoiceId, "invoice.paid",
    { status: "paid", paidAt: v.paidAt ?? new Date() }, v.actorKind, v.actorId,
  );
}

export async function voidInvoice(db: Db, organisationId: string, input: z.input<typeof InvoiceActionInput>) {
  const v = InvoiceActionInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [existing] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
  // Voiding a settled invoice would silently unbalance the ledger; a refund is
  // recorded as a payment instead.
  if (existing!.status === "paid") throw new Error(`invoice ${existing!.number} is paid and cannot be voided`);
  return transition(db, organisationId, v.invoiceId, "invoice.voided", { status: "void" }, v.actorKind, v.actorId);
}
