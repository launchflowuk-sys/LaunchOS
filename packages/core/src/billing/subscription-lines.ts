import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

/**
 * What a client's monthly charge is made of, and how it is collected.
 *
 * `subscriptions.amount_pence` was one number because it was written for
 * Stripe, where one subscription is one price. Real arrangements are not
 * shaped like that: AMO Rendering pays £200 a month — two websites at £45 and
 * ad management at £110 — as a single bank transfer, and the Payments screen
 * read "£99.00 active" because there was nowhere to put the parts.
 *
 * The total is **derived**, never typed. A figure somebody can edit separately
 * from the lines is a figure that disagrees with them by the end of the
 * quarter, and the invoice and the screen would then be reading different
 * numbers for the same client.
 */

export const SubscriptionLineInput = z.object({
  description: z.string().trim().min(1, "each line needs a description").max(300),
  /** Two websites at £45 is one line with quantity 2, not two lines. */
  quantity: z.number().int().min(1).max(999).default(1),
  unitAmountPence: z.number().int().min(0).max(100_000_000),
  packageId: z.string().uuid().nullish(),
});
export type SubscriptionLineInput = z.input<typeof SubscriptionLineInput>;

export const SetSubscriptionLinesInput = z.object({
  subscriptionId: z.string().uuid(),
  /** The whole set. Absent lines are removed — this is a replace, not a merge. */
  lines: z.array(SubscriptionLineInput).max(50),
  collectionMethod: z
    .enum(["stripe", "bank_transfer", "standing_order", "direct_debit", "cash", "other"])
    .optional(),
  billingNotes: z.string().trim().max(2000).nullish(),
  actorId: z.string().min(1),
});
export type SetSubscriptionLinesInput = z.input<typeof SetSubscriptionLinesInput>;

export interface SubscriptionLineRow {
  id: string;
  description: string;
  quantity: number;
  unitAmountPence: number;
  packageId: string | null;
  sort: number;
}

/** Quantity × unit, summed. The only place the monthly figure is decided. */
export function totalOf(lines: readonly { quantity: number; unitAmountPence: number }[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitAmountPence, 0);
}

export async function listSubscriptionLines(
  db: Db,
  organisationId: string,
  subscriptionId: string,
): Promise<SubscriptionLineRow[]> {
  return db
    .select({
      id: schema.subscriptionLines.id,
      description: schema.subscriptionLines.description,
      quantity: schema.subscriptionLines.quantity,
      unitAmountPence: schema.subscriptionLines.unitAmountPence,
      packageId: schema.subscriptionLines.packageId,
      sort: schema.subscriptionLines.sort,
    })
    .from(schema.subscriptionLines)
    .where(and(
      eq(schema.subscriptionLines.organisationId, organisationId),
      eq(schema.subscriptionLines.subscriptionId, subscriptionId),
    ))
    .orderBy(asc(schema.subscriptionLines.sort));
}

/**
 * Replaces the lines and re-derives the total, in one transaction.
 *
 * All of it or none: a subscription left holding new lines beside the old
 * total is a client invoiced for one figure and shown another, which is worse
 * than the edit never having happened.
 *
 * An empty list is allowed and means "no breakdown recorded". The total is
 * then left alone rather than zeroed — clearing the lines is somebody
 * tidying up, not a statement that the client now pays nothing.
 */
export async function setSubscriptionLines(
  db: Db,
  organisationId: string,
  input: SetSubscriptionLinesInput,
): Promise<{ lines: SubscriptionLineRow[]; amountPence: number }> {
  const v = SetSubscriptionLinesInput.parse(input);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.subscriptions)
      .where(and(
        eq(schema.subscriptions.id, v.subscriptionId),
        eq(schema.subscriptions.organisationId, organisationId),
      ));
    if (!before) throw new Error("that subscription could not be found");

    await tx.delete(schema.subscriptionLines).where(and(
      eq(schema.subscriptionLines.organisationId, organisationId),
      eq(schema.subscriptionLines.subscriptionId, v.subscriptionId),
    ));

    if (v.lines.length > 0) {
      await tx.insert(schema.subscriptionLines).values(
        v.lines.map((line, index) => ({
          organisationId,
          subscriptionId: v.subscriptionId,
          description: line.description,
          quantity: line.quantity,
          unitAmountPence: line.unitAmountPence,
          packageId: line.packageId ?? null,
          sort: index,
        })),
      );
    }

    const amountPence = v.lines.length > 0 ? totalOf(v.lines.map((l) => ({ ...l, quantity: l.quantity ?? 1 }))) : before.amountPence;
    const [after] = await tx.update(schema.subscriptions)
      .set({
        amountPence,
        ...(v.collectionMethod ? { collectionMethod: v.collectionMethod } : {}),
        ...(v.billingNotes === undefined ? {} : { billingNotes: v.billingNotes ?? null }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.subscriptions.id, v.subscriptionId),
        eq(schema.subscriptions.organisationId, organisationId),
      ))
      .returning();

    await recordAudit(tx, organisationId, {
      actorKind: "user", actorId: v.actorId, action: "subscription.lines_set",
      targetType: "subscription", targetId: v.subscriptionId,
      before: { amountPence: before.amountPence, collectionMethod: before.collectionMethod },
      after: { amountPence: after!.amountPence, collectionMethod: after!.collectionMethod, lines: v.lines.length },
    });

    return { lines: await listSubscriptionLines(tx, organisationId, v.subscriptionId), amountPence };
  });
}

/**
 * Every subscription that somebody has to chase money for this period.
 *
 * Stripe collects itself, so it is excluded: what is left is the work list —
 * an invoice to raise, or a transfer to check has landed. Before this, that
 * list did not exist anywhere and the answer was somebody's memory.
 */
export async function subscriptionsNeedingCollection(
  db: Db,
  organisationId: string,
): Promise<{ id: string; clientId: string; clientName: string; amountPence: number; currency: string; collectionMethod: string; currentPeriodEnd: Date }[]> {
  return db
    .select({
      id: schema.subscriptions.id,
      clientId: schema.subscriptions.clientId,
      clientName: schema.clients.name,
      amountPence: schema.subscriptions.amountPence,
      currency: schema.subscriptions.currency,
      collectionMethod: schema.subscriptions.collectionMethod,
      currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.clients, eq(schema.subscriptions.clientId, schema.clients.id))
    .where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      eq(schema.subscriptions.status, "active"),
    ))
    .orderBy(asc(schema.subscriptions.currentPeriodEnd));
}
