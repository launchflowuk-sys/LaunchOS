import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertOrgMember } from "../tenancy/assert-owned.js";

export const NotifyInput = z.object({
  userId: z.string().min(1),
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  link: z.string().max(500).optional(),
});
export type NotifyInput = z.input<typeof NotifyInput>;

export async function notify(db: Db, organisationId: string, input: NotifyInput) {
  const v = NotifyInput.parse(input);
  await assertOrgMember(db, organisationId, v.userId);
  const [row] = await db
    .insert(schema.notifications)
    .values({ organisationId, userId: v.userId, kind: v.kind, title: v.title, body: v.body ?? null, link: v.link ?? null })
    .returning();
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
