import { randomUUID } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";

/**
 * The smallest world a task test needs: an organisation, an owner user and
 * member row, a package and a client already on that package.
 */
export async function seedOrgWithClient(db: Db) {
  const [organisation] = await db.insert(schema.organisations)
    .values({ name: "Test Org", slug: `org-${randomUUID()}` }).returning();
  const [ownerUser] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: "Owner", email: `owner-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId: organisation!.id, userId: ownerUser!.id, role: "owner", status: "active" });
  const [pkg] = await db.insert(schema.packages).values({
    organisationId: organisation!.id, name: "Website + SEO + Social", slug: `pkg-${randomUUID()}`,
    includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: organisation!.id, name: "Grays CabLine", slug: `client-${randomUUID()}`, packageId: pkg!.id,
  }).returning();
  return { organisationId: organisation!.id, ownerUserId: ownerUser!.id, clientId: client!.id, packageId: pkg!.id };
}

/** A second active staff member, for assignment tests. */
export async function addStaffMember(db: Db, organisationId: string, displayName = "Staff") {
  const [staff] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: displayName, email: `staff-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId, userId: staff!.id, role: "staff", status: "active", displayName });
  return staff!.id;
}
