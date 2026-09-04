import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsAdapter, PaymentsInvoice } from "@launchos/integrations";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTIVE_STATUSES = ["trialing", "active", "past_due"] as const;

export const CreateSubscriptionServiceInput = z.object({
  clientId: z.string().uuid(),
  packageId: z.string().uuid(),
  periodStart: z.date().default(() => new Date()),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CreateSubscriptionServiceInput = z.input<typeof CreateSubscriptionServiceInput>;

export async function createSubscription(
  db: Db,
  organisationId: string,
  input: CreateSubscriptionServiceInput,
  payments: PaymentsAdapter,
): Promise<{ subscription: typeof schema.subscriptions.$inferSelect; providerInvoice: PaymentsInvoice }> {
  const v = CreateSubscriptionServiceInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, v.clientId);
  await assertOwned(db, organisationId, schema.packages, v.packageId);

  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, v.clientId));
  const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.id, v.packageId));
  const [profile] = await db.select().from(schema.billingProfiles).where(and(
    eq(schema.billingProfiles.organisationId, organisationId),
    eq(schema.billingProfiles.clientId, v.clientId),
  ));
  if (!profile) throw new Error(`client ${v.clientId} has no billing profile`);

  // The provider round trip happens before the transaction: an HTTP call must
  // never hold a database transaction open, and a failure here should leave no
  // local rows behind at all.
  const customerId = profile.stripeCustomerId
    ?? (await payments.createCustomer({
      name: profile.billingName ?? client!.name,
      email: client!.email ?? undefined,
      clientRef: client!.slug,
    })).id;

  const created = await payments.createSubscription({
    customerId,
    amountPence: pkg!.monthlyPricePence,
    currency: pkg!.currency,
    description: `${pkg!.name} — monthly retainer`,
    periodStart: v.periodStart,
  });

  const subscription = await db.transaction(async (tx) => {
    if (!profile.stripeCustomerId) {
      await tx.update(schema.billingProfiles)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(schema.billingProfiles.id, profile.id));
    }
    const [row] = await tx.insert(schema.subscriptions).values({
      organisationId,
      clientId: v.clientId,
      packageId: v.packageId,
      stripeSubscriptionId: created.subscription.id,
      status: created.subscription.status,
      currentPeriodStart: created.subscription.currentPeriodStart,
      currentPeriodEnd: created.subscription.currentPeriodEnd,
      amountPence: created.subscription.amountPence,
      currency: created.subscription.currency,
    }).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "subscription.created",
      targetType: "subscription", targetId: row!.id, after: row,
    });
    return row!;
  });

  await recordActivity(db, organisationId, {
    clientId: v.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "subscription.created",
    title: `Subscription started on ${pkg!.name}`,
    body: `£${(pkg!.monthlyPricePence / 100).toFixed(2)} per month via ${payments.name}.`,
    link: `/clients/${v.clientId}/billing`,
  });

  return { subscription, providerInvoice: created.invoice };
}

export const CancelSubscriptionInput = z.object({
  subscriptionId: z.string().uuid(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type CancelSubscriptionInput = z.input<typeof CancelSubscriptionInput>;

export async function cancelSubscription(
  db: Db,
  organisationId: string,
  input: CancelSubscriptionInput,
  payments: PaymentsAdapter,
) {
  const v = CancelSubscriptionInput.parse(input);
  await assertOwned(db, organisationId, schema.subscriptions, v.subscriptionId);
  const [before] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, v.subscriptionId));
  if (before!.stripeSubscriptionId) await payments.cancelSubscription(before!.stripeSubscriptionId);

  const [after] = await db.update(schema.subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(schema.subscriptions.id, v.subscriptionId))
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "subscription.cancelled",
    targetType: "subscription", targetId: v.subscriptionId, before, after,
  });
  await recordActivity(db, organisationId, {
    clientId: after!.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "subscription.cancelled",
    title: "Subscription cancelled", link: `/clients/${after!.clientId}/billing`,
  });
  return after!;
}

export async function activeSubscriptionForClient(db: Db, organisationId: string, clientId: string) {
  const [row] = await db.select().from(schema.subscriptions).where(and(
    eq(schema.subscriptions.organisationId, organisationId),
    eq(schema.subscriptions.clientId, clientId),
    inArray(schema.subscriptions.status, [...ACTIVE_STATUSES]),
    isNull(schema.subscriptions.deletedAt),
  )).orderBy(schema.subscriptions.createdAt).limit(1);
  return row;
}
