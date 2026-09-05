import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PackageIncludes } from "@launchos/db/schema";
import { and, eq } from "drizzle-orm";

export const INCLUDES: PackageIncludes = {
  website: true, seo: false, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2,
};

/**
 * The smallest world a content test needs: an organisation with an owner, a
 * client on a package with quotas, an active subscription and one portal user.
 */
export async function contentFixture(db: Db, opts: { includes?: PackageIncludes; withSubscription?: boolean; name?: string } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `content-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });

  const [pkg] = await db.insert(schema.packages).values({
    organisationId: org!.id, name: "Growth", slug: `growth-${randomUUID()}`, monthlyPricePence: 14900, includes: opts.includes ?? INCLUDES,
  }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: opts.name ?? "Grays CabLine", slug: `grays-${randomUUID()}`, email: "info@grays.test", packageId: pkg!.id,
  }).returning();

  const portalUserId = randomUUID();
  await db.insert(schema.user).values({ id: portalUserId, name: "Portal", email: `portal-${portalUserId}@grays.test`, emailVerified: true });
  await db.insert(schema.clientUsers).values({ organisationId: org!.id, clientId: client!.id, userId: portalUserId, role: "client_admin" });

  const [subscription] = opts.withSubscription === false
    ? []
    : await db.insert(schema.subscriptions).values({
        organisationId: org!.id, clientId: client!.id, packageId: pkg!.id, status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-09-30T23:59:59Z"),
        amountPence: 14900, currency: "GBP",
      }).returning();

  return { orgId: org!.id, ownerId, clientId: client!.id, packageId: pkg!.id, portalUserId, subscription };
}

export function auditRows(db: Db, organisationId: string, action: string) {
  return db.select().from(schema.auditLog).where(and(
    eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, action),
  ));
}

export function ownerNotifications(db: Db, organisationId: string) {
  return db.select().from(schema.notifications).where(eq(schema.notifications.organisationId, organisationId));
}
