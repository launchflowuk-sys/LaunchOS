import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOrgMember } from "../tenancy/assert-owned.js";

export type PushSubscriptionRow = typeof schema.pushSubscriptions.$inferSelect;

export const SavePushSubscriptionInput = z.object({
  userId: z.string().min(1),
  endpoint: z.string().url().max(2000),
  p256dh: z.string().min(1).max(500),
  auth: z.string().min(1).max(500),
  userAgent: z.string().max(500).optional(),
});
export type SavePushSubscriptionInput = z.input<typeof SavePushSubscriptionInput>;

/**
 * Registers (or refreshes) one browser's push subscription for a staff user.
 *
 * The endpoint is unique across the whole table: a browser that subscribes
 * again gets its keys updated in place, and a browser that was signed in as
 * somebody else is moved to the new user rather than left delivering their
 * alerts. `failed_at` is cleared — a fresh subscription is a fresh start.
 */
export async function savePushSubscription(db: Db, organisationId: string, input: SavePushSubscriptionInput): Promise<PushSubscriptionRow> {
  const v = SavePushSubscriptionInput.parse(input);
  await assertOrgMember(db, organisationId, v.userId);
  const now = new Date();
  const [row] = await db
    .insert(schema.pushSubscriptions)
    .values({
      organisationId, userId: v.userId, endpoint: v.endpoint, p256dh: v.p256dh, auth: v.auth,
      userAgent: v.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: {
        organisationId, userId: v.userId, p256dh: v.p256dh, auth: v.auth,
        userAgent: v.userAgent ?? null, failedAt: null, updatedAt: now,
      },
    })
    .returning();
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.userId, action: "push_subscription.saved",
    targetType: "push_subscription", targetId: row!.id,
    // Never the keys: the audit log is readable by every admin.
    after: { userId: v.userId, endpointHost: new URL(v.endpoint).host, userAgent: v.userAgent ?? null },
  });
  return row!;
}

export const RemovePushSubscriptionInput = z
  .object({
    userId: z.string().min(1),
    endpoint: z.string().url().optional(),
    subscriptionId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.endpoint) !== Boolean(v.subscriptionId), { message: "pass either endpoint or subscriptionId" });
export type RemovePushSubscriptionInput = z.input<typeof RemovePushSubscriptionInput>;

/** A user unsubscribing one of their own devices. Scoped to the user as well as the organisation. */
export async function removePushSubscription(db: Db, organisationId: string, input: RemovePushSubscriptionInput): Promise<PushSubscriptionRow | null> {
  const v = RemovePushSubscriptionInput.parse(input);
  const [row] = await db
    .delete(schema.pushSubscriptions)
    .where(and(
      eq(schema.pushSubscriptions.organisationId, organisationId),
      eq(schema.pushSubscriptions.userId, v.userId),
      v.endpoint ? eq(schema.pushSubscriptions.endpoint, v.endpoint) : eq(schema.pushSubscriptions.id, v.subscriptionId!),
    ))
    .returning();
  if (!row) return null;
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.userId, action: "push_subscription.removed",
    targetType: "push_subscription", targetId: row.id, before: { userId: row.userId, endpointHost: new URL(row.endpoint).host },
  });
  return row;
}

export const ListPushSubscriptionsInput = z.object({ userId: z.string().min(1) });
export type ListPushSubscriptionsInput = z.input<typeof ListPushSubscriptionsInput>;

export async function listPushSubscriptions(db: Db, organisationId: string, input: ListPushSubscriptionsInput): Promise<PushSubscriptionRow[]> {
  const v = ListPushSubscriptionsInput.parse(input);
  return db
    .select()
    .from(schema.pushSubscriptions)
    .where(and(eq(schema.pushSubscriptions.organisationId, organisationId), eq(schema.pushSubscriptions.userId, v.userId)))
    .orderBy(asc(schema.pushSubscriptions.createdAt));
}

export async function countPushSubscriptions(db: Db, organisationId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.pushSubscriptions)
    .where(and(eq(schema.pushSubscriptions.organisationId, organisationId), eq(schema.pushSubscriptions.userId, userId)));
  return row?.value ?? 0;
}

export const RecordPushDeliveryInput = z.object({
  subscriptionId: z.string().uuid(),
  /** `sent` stamps last_used_at; `failed` stamps failed_at; `gone` (404/410 from the push service) deletes the row. */
  outcome: z.enum(["sent", "failed", "gone"]),
  error: z.string().max(500).optional(),
});
export type RecordPushDeliveryInput = z.input<typeof RecordPushDeliveryInput>;

/**
 * What the worker's `push.send` job records after each attempt. A subscription
 * the push service no longer knows (`gone`) is removed and audited so the
 * user's account page stops listing a device that will never ring again.
 */
export async function recordPushDelivery(db: Db, organisationId: string, input: RecordPushDeliveryInput): Promise<PushSubscriptionRow | null> {
  const v = RecordPushDeliveryInput.parse(input);
  const where = and(eq(schema.pushSubscriptions.id, v.subscriptionId), eq(schema.pushSubscriptions.organisationId, organisationId));
  const now = new Date();
  if (v.outcome === "gone") {
    const [removed] = await db.delete(schema.pushSubscriptions).where(where).returning();
    if (!removed) return null;
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "push_subscription.expired", targetType: "push_subscription", targetId: removed.id,
      before: { userId: removed.userId, endpointHost: new URL(removed.endpoint).host, error: v.error ?? null },
    });
    return removed;
  }
  const [row] = await db
    .update(schema.pushSubscriptions)
    .set(v.outcome === "sent" ? { lastUsedAt: now, failedAt: null, updatedAt: now } : { failedAt: now, updatedAt: now })
    .where(where)
    .returning();
  return row ?? null;
}
