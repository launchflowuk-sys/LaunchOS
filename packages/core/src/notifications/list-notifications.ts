import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

export const ListNotificationsInput = z.object({
  userId: z.string().min(1),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
});
export type ListNotificationsInput = z.input<typeof ListNotificationsInput>;

export async function listNotifications(db: Db, organisationId: string, input: ListNotificationsInput) {
  const v = ListNotificationsInput.parse(input);
  return db
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, v.userId),
        v.unreadOnly ? isNull(schema.notifications.readAt) : undefined,
      ),
    )
    // `created_at` alone is not a total order: several notifications written in
    // one transaction share a timestamp, and the bell would then shuffle them
    // between requests. `id desc` breaks the tie deterministically.
    .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
    .limit(v.limit);
}

/** One notification by id, for the worker's `push.send` job. Null when it does not exist in this organisation. */
export async function getNotification(db: Db, organisationId: string, notificationId: string) {
  const [row] = await db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.id, notificationId), eq(schema.notifications.organisationId, organisationId)))
    .limit(1);
  return row ?? null;
}

export async function countUnreadNotifications(db: Db, organisationId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    );
  return row?.value ?? 0;
}

export const MarkReadInput = z.object({ userId: z.string().min(1), notificationId: z.string().uuid() });
export type MarkReadInput = z.input<typeof MarkReadInput>;

/** Scoped by userId as well as organisation: nobody reads another user's bell. */
export async function markNotificationRead(db: Db, organisationId: string, input: MarkReadInput) {
  const v = MarkReadInput.parse(input);
  const [row] = await db
    .update(schema.notifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.notifications.id, v.notificationId),
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, v.userId),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markAllNotificationsRead(db: Db, organisationId: string, userId: string): Promise<number> {
  const rows = await db
    .update(schema.notifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.notifications.organisationId, organisationId),
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning({ id: schema.notifications.id });
  return rows.length;
}
