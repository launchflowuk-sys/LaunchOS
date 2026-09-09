import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { addMonths } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";

/**
 * Files the subscription a completed Checkout produced.
 *
 * Shared by every door a subscription can come through — an accepted
 * proposal's payment and a client buying from their own portal — because the
 * filing is the same job each time and two copies of it would drift on the
 * detail that matters: the `(organisation_id, stripe_subscription_id)` unique
 * index, which is what stops a replayed webhook filing one Stripe subscription
 * twice.
 *
 * Returns the row's id, whether this call inserted it or found the one a
 * concurrent delivery had already written. Null only when there was no
 * subscription to record at all — a purely one-off payment.
 */
export async function recordSubscription(
  db: Db,
  organisationId: string,
  input: {
    clientId: string;
    packageId: string | null;
    stripeSubscriptionId: string | null;
    sessionId: string;
    now: Date;
  },
): Promise<string | null> {
  if (!input.stripeSubscriptionId) return null;

  const [pkg] = input.packageId
    ? await db
      .select({ monthlyPricePence: schema.packages.monthlyPricePence, currency: schema.packages.currency })
      .from(schema.packages)
      .where(and(eq(schema.packages.id, input.packageId), eq(schema.packages.organisationId, organisationId)))
    : [undefined];

  const [row] = await db.insert(schema.subscriptions).values({
    organisationId,
    clientId: input.clientId,
    packageId: input.packageId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    status: "active",
    currentPeriodStart: input.now,
    currentPeriodEnd: addMonths(input.now, 1),
    amountPence: pkg?.monthlyPricePence ?? 0,
    currency: pkg?.currency ?? "GBP",
    metadata: { checkoutSessionId: input.sessionId },
  })
    // The unique `(organisation_id, stripe_subscription_id)` index is the
    // second belt: a replayed event with a new session id still cannot file
    // the same Stripe subscription twice.
    .onConflictDoNothing({ target: [schema.subscriptions.organisationId, schema.subscriptions.stripeSubscriptionId] })
    .returning();

  if (row) {
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "subscription.created",
      targetType: "subscription", targetId: row.id, after: row,
    });
    return row.id;
  }

  const [existing] = await db.select({ id: schema.subscriptions.id }).from(schema.subscriptions)
    .where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      eq(schema.subscriptions.stripeSubscriptionId, input.stripeSubscriptionId),
    ));
  return existing?.id ?? null;
}
