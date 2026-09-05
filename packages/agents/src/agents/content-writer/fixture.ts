import { randomUUID } from "node:crypto";
import { createKnowledgeArticle, planContentMonth, setContentChannel, upsertContentBrief } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PackageIncludes } from "@launchos/db/schema";

export const PERIOD = "2026-09";

export const INCLUDES: PackageIncludes = {
  website: true, seo: false, ads: false, socialPostsPerMonth: 2, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 1,
};

/**
 * A client the writer can work for: an organisation with an owner, a package
 * with quotas, an active subscription, a brief, a site, connected channels,
 * one published knowledge article and the month's slots already planned.
 * Test-only; the shipped fixture in `packages/core` is not exported.
 */
export async function writerFixture(db: Db, opts: { includes?: PackageIncludes; brief?: boolean; plan?: boolean } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `writer-${randomUUID()}` }).returning();
  const orgId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: orgId, userId: ownerId, role: "owner", status: "active" });

  const [pkg] = await db.insert(schema.packages).values({
    organisationId: orgId, name: "Growth", slug: `growth-${randomUUID()}`, monthlyPricePence: 14900, includes: opts.includes ?? INCLUDES,
  }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId: orgId, name: "Grays CabLine", slug: `grays-${randomUUID()}`, email: "info@grays.test",
    websiteUrl: "https://grayscabline.co.uk", city: "Grays", packageId: pkg!.id,
  }).returning();
  const clientId = client!.id;
  await db.insert(schema.subscriptions).values({
    organisationId: orgId, clientId, packageId: pkg!.id, status: "active",
    currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-09-30T23:59:59Z"),
    amountPence: 14900, currency: "GBP",
  });
  const [site] = await db.insert(schema.sites).values({
    organisationId: orgId, clientId, name: "Grays CabLine", primaryUrl: "https://grayscabline.co.uk", hostingRef: "app_grays",
  }).returning();

  if (opts.brief !== false) {
    await upsertContentBrief(db, orgId, {
      clientId, tone: "Friendly, plain, local", audience: "People in Thurrock who need a reliable taxi",
      services: "Airport transfers, local journeys, school runs", offers: "10% off first airport booking",
      area: "Grays, Thurrock, Essex", doNotSay: "cheapest", actorKind: "system",
    });
  }
  await setContentChannel(db, orgId, { clientId, channel: "facebook", externalId: "1234567890", displayName: "Grays CabLine", actorKind: "system" });
  await setContentChannel(db, orgId, { clientId, channel: "blog", externalId: site!.id, displayName: "grayscabline.co.uk", actorKind: "system" });
  await createKnowledgeArticle(db, orgId, {
    title: "Airport transfers", bodyMd: "Fixed fares to Stansted, Heathrow and Gatwick, booked in advance.", tags: ["taxi"], published: true,
  });

  const planned = opts.plan === false ? [] : (await planContentMonth(db, orgId, { clientId, periodKey: PERIOD })).items;
  return { orgId, ownerId, clientId, siteId: site!.id, packageId: pkg!.id, planned };
}
