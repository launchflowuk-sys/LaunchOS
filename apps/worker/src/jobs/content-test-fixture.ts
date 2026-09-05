import { randomUUID } from "node:crypto";
import { createContentItem, setContentChannel } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentChannel, PackageIncludes } from "@launchos/db/schema";
import { eq } from "drizzle-orm";

export const INCLUDES: PackageIncludes = {
  website: true, seo: false, ads: false, socialPostsPerMonth: 2, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 1,
};

/**
 * An organisation with an owner and one client on a package with quotas,
 * subscribed unless told otherwise. Test-only: `packages/core`'s own fixture
 * is not exported, and these jobs need a few shapes it does not make.
 */
export async function contentJobFixture(db: Db, opts: { includes?: PackageIncludes; subscribed?: boolean; name?: string } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `cj-${randomUUID()}` }).returning();
  const orgId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: ownerId, role: "owner", status: "active" });
  const client = await addClient(db, orgId, { ...opts, name: opts.name ?? "Grays CabLine" });
  return { orgId, ownerId, ...client };
}

/** Another client in the same organisation, with its own package and (by default) subscription. */
export async function addClient(db: Db, orgId: string, opts: { includes?: PackageIncludes; subscribed?: boolean; name: string }) {
  const [pkg] = await db.insert(schema.packages).values({
    organisationId: orgId, name: `Pkg ${opts.name}`, slug: `pkg-${randomUUID()}`, monthlyPricePence: 9900, includes: opts.includes ?? INCLUDES,
  }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: orgId, name: opts.name, slug: `c-${randomUUID()}`, email: "info@client.test", packageId: pkg!.id,
  }).returning();
  if (opts.subscribed !== false) {
    await db.insert(schema.subscriptions).values({
      organisationId: orgId, clientId: client!.id, packageId: pkg!.id, status: "active",
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-09-30T23:59:59Z"),
      amountPence: 9900, currency: "GBP",
    });
  }
  return { clientId: client!.id, packageId: pkg!.id };
}

export async function connectChannel(db: Db, orgId: string, clientId: string, channel: ContentChannel, externalId: string) {
  return setContentChannel(db, orgId, { clientId, channel, externalId, actorKind: "system" });
}

/** An item already approved for a moment, the way `applyContentPublishDecision` leaves it. */
export async function approvedItem(
  db: Db,
  orgId: string,
  clientId: string,
  channel: ContentChannel,
  scheduledFor: Date,
  fields: { body?: string; title?: string; imageUrl?: string; linkUrl?: string } = {},
) {
  const item = await createContentItem(db, orgId, {
    clientId, channel, scheduledFor, body: fields.body ?? "Fixed fares to Stansted, booked in advance.",
    ...(fields.title !== undefined && { title: fields.title }),
    ...(fields.imageUrl !== undefined && { imageUrl: fields.imageUrl }),
    ...(fields.linkUrl !== undefined && { linkUrl: fields.linkUrl }),
    actorKind: "system",
  });
  const [approved] = await db.update(schema.contentItems).set({ status: "approved" }).where(eq(schema.contentItems.id, item.id)).returning();
  return approved!;
}

export async function itemById(db: Db, itemId: string) {
  const [row] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, itemId));
  return row!;
}

export function silentLogger() {
  return { info() {}, warn() {}, error() {} } as unknown as Console;
}
