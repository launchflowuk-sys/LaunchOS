import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { InvoiceLineItem } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { nextInvoiceNumber } from "./invoice-number.js";
import { vatRateForOrganisation } from "./vat-rate.js";

export { VAT_RATE_DEFAULT_PERCENT } from "./vat-rate.js";
export const PAYMENT_TERMS_DEFAULT_DAYS = 14;

const ActorKind = z.enum(["user", "client", "agent", "system"]);
type ActorKind = z.infer<typeof ActorKind>;

export const CreateInvoiceFromSubscriptionInput = z.object({
  subscriptionId: z.string().uuid(),
  issuedAt: z.date().optional(),
  /**
   * The rate to charge *if the organisation is registered for VAT*. Omit it
   * and the organisation's configured rate is used. It is a preference, never
   * an authority: an unregistered supplier is zero-rated whatever is passed
   * here — see `vatRateForOrganisation`.
   */
  vatRatePercent: z.number().min(0).max(100).optional(),
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
  // The organisation's VAT registration, not the caller, decides whether this
  // invoice may carry VAT at all. A caller may pin a rate for a registered
  // supplier (a reduced rate, a historic re-raise); it cannot conjure one for
  // an unregistered supplier, whose invoices are zero-rated by law.
  const registeredRatePercent = await vatRateForOrganisation(db, organisationId);
  const vatRatePercent = registeredRatePercent > 0 ? v.vatRatePercent ?? registeredRatePercent : 0;
  const vatPence = Math.round((subtotalPence * vatRatePercent) / 100);
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

/**
 * The update and its audit row commit as one transaction — a status change
 * with no audit trail is worse than no status change at all. Callers that
 * have already asserted ownership and fetched the current row (`voidInvoice`)
 * pass it as `before` directly, rather than this function re-asserting and
 * re-querying what the caller already has.
 */
async function applyTransition(
  db: Db,
  organisationId: string,
  invoiceId: string,
  before: typeof schema.invoices.$inferSelect,
  action: string,
  patch: Partial<typeof schema.invoices.$inferInsert>,
  actorKind: ActorKind,
  actorId: string | undefined,
) {
  return db.transaction(async (tx) => {
    const [after] = await tx.update(schema.invoices)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.invoices.id, invoiceId))
      .returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action, targetType: "invoice", targetId: invoiceId, before, after,
    });
    return after!;
  });
}

export type InvoiceStatus = (typeof schema.invoices.$inferSelect)["status"];

/**
 * The whole legal state machine, enforced in core rather than left to each
 * caller. `paid` and `void` are terminal — a settled or cancelled invoice is a
 * financial record, and un-settling one is a credit note, not an edit. `draft`
 * cannot jump straight to `paid`: an invoice the client was never sent is not
 * something they can have paid, and letting it skip `sent` hides a missing
 * step in the ledger.
 *
 * `sent -> sent` and `overdue -> overdue` are deliberate self-transitions: a
 * resend and an overdue chase are both real sends, and neither one changes what
 * the status is asserting. `overdue -> sent` is **not** legal — chasing a debt
 * does not un-overdue it, and letting a chase reset the status would hand the
 * invoice back to the overdue sweep as if it had never been flagged.
 *
 * This map is the only authority. Anything that needs to know whether a status
 * change is legal — including the send path and the overdue sweep — derives it
 * from here via `canTransition` / `isSendableStatus` / `statusesThatCanBecome`
 * rather than restating the rule in its own list or `WHERE` clause.
 */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["sent", "void"],
  sent: ["sent", "paid", "overdue", "void"],
  overdue: ["overdue", "paid", "void"],
  paid: [],
  void: [],
};

/** Explains the refusal in the operator's terms, not the state machine's. */
const TRANSITION_HINT: Partial<Record<`${InvoiceStatus}->${InvoiceStatus}`, string>> = {
  "draft->paid": "send it first",
  "paid->void": "a paid invoice is settled; record a refund instead",
  "void->paid": "a void invoice cannot be paid; raise a new one",
  "void->sent": "a void invoice cannot be sent; raise a new one",
  "overdue->sent": "chasing an overdue invoice does not un-overdue it",
};

/** Whether the state machine allows `from -> to`. */
export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Where a send leaves the invoice. A chase records itself in
 * `metadata.sendHistory` — that is the audit record that matters — while the
 * status keeps saying the money is late.
 */
export function sendTargetStatus(from: InvoiceStatus): InvoiceStatus {
  return from === "overdue" ? "overdue" : "sent";
}

/** Derived from the map, so there is no second list of sendable statuses to drift. */
export function isSendableStatus(from: InvoiceStatus): boolean {
  return canTransition(from, sendTargetStatus(from));
}

/** Every status the map allows to reach `to` — the sweep's candidate set. */
export function statusesThatCanBecome(to: InvoiceStatus): InvoiceStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as InvoiceStatus[]).filter((from) => canTransition(from, to));
}

function assertTransition(invoice: typeof schema.invoices.$inferSelect, to: InvoiceStatus): void {
  if (ALLOWED_TRANSITIONS[invoice.status].includes(to)) return;
  const hint = TRANSITION_HINT[`${invoice.status}->${to}`];
  throw new Error(`invoice ${invoice.number} is ${invoice.status} and cannot be marked ${to}${hint ? ` — ${hint}` : ""}`);
}

async function transition(
  db: Db,
  organisationId: string,
  invoiceId: string,
  action: string,
  patch: Partial<typeof schema.invoices.$inferInsert> & { status: InvoiceStatus },
  actorKind: ActorKind,
  actorId: string | undefined,
) {
  await assertOwned(db, organisationId, schema.invoices, invoiceId);
  const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  assertTransition(before!, patch.status);
  return applyTransition(db, organisationId, invoiceId, before!, action, patch, actorKind, actorId);
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

/**
 * Voiding a settled invoice would silently unbalance the ledger; a refund is
 * recorded as a payment instead. `assertTransition` is the single authority on
 * that — voiding a `paid` or an already-`void` invoice is refused there.
 */
export async function voidInvoice(db: Db, organisationId: string, input: z.input<typeof InvoiceActionInput>) {
  const v = InvoiceActionInput.parse(input);
  await assertOwned(db, organisationId, schema.invoices, v.invoiceId);
  const [existing] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
  assertTransition(existing!, "void");
  return applyTransition(db, organisationId, v.invoiceId, existing!, "invoice.voided", { status: "void" }, v.actorKind, v.actorId);
}
