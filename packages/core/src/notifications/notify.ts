import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { emit } from "../events/emit.js";
import { countPushSubscriptions } from "../push/subscriptions.js";
import { pushForNotification } from "../push/urgent.js";
import { assertOrgMember } from "../tenancy/assert-owned.js";

export const NotifyInput = z.object({
  userId: z.string().min(1),
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  link: z.string().max(500).optional(),
});
export type NotifyInput = z.input<typeof NotifyInput>;

/**
 * Writes the bell notification and, for an urgent kind
 * (`pushForNotification`) going to a user who has at least one device
 * subscribed, asks the worker to push it as well.
 *
 * The push request is best effort by design: `emit` can fail (a queue that
 * is not installed, a database hiccup on the job insert) and that must never
 * fail the business write that raised the notification — an incident is
 * still an incident with no phone alert. The failure is logged, not thrown.
 */
export async function notify(db: Db, organisationId: string, input: NotifyInput) {
  const v = NotifyInput.parse(input);
  await assertOrgMember(db, organisationId, v.userId);
  const [row] = await db
    .insert(schema.notifications)
    .values({ organisationId, userId: v.userId, kind: v.kind, title: v.title, body: v.body ?? null, link: v.link ?? null })
    .returning();
  if (pushForNotification(v.kind)) {
    try {
      if ((await countPushSubscriptions(db, organisationId, v.userId)) > 0) {
        await emit({ name: "push.requested", organisationId, notificationId: row!.id, userId: v.userId });
      }
    } catch (error) {
      console.error(
        { organisationId, notificationId: row!.id, kind: v.kind, error: error instanceof Error ? error.message : String(error) },
        "push request failed; the bell notification is written",
      );
    }
  }
  return row!;
}

export const NotifyOwnerInput = NotifyInput.omit({ userId: true });
export type NotifyOwnerInput = z.input<typeof NotifyOwnerInput>;

/**
 * In-app notification for whoever runs the organisation — the oldest active
 * owner membership. Returns null when there is no owner yet (a fresh
 * organisation before the seed), so callers never fail because of it.
 * Email delivery to OWNER_NOTIFY_EMAIL arrives with the email adapter in Plan 4.
 */
export async function notifyOwner(db: Db, organisationId: string, input: NotifyOwnerInput) {
  const v = NotifyOwnerInput.parse(input);
  const [owner] = await db
    .select({ userId: schema.organisationMembers.userId })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.role, "owner"),
        eq(schema.organisationMembers.status, "active"),
      ),
    )
    .orderBy(asc(schema.organisationMembers.createdAt))
    .limit(1);
  if (!owner) return null;
  return notify(db, organisationId, { ...v, userId: owner.userId });
}
