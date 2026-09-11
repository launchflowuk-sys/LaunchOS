import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import type { PackageIncludes } from "@launchos/db/schema";
import { withTestDb } from "@launchos/db/test";
import type { Db } from "@launchos/db";
import {
  activeServicesForClient, clientIdsWithService, includesForServices, listClientServices, servicesPaidFor,
  setClientService, SERVICE_FOR_CHANNEL,
} from "./services.js";

const FULL: PackageIncludes = {
  website: true, seo: true, ads: true, socialPostsPerMonth: 8, blogPostsPerMonth: 2, gbpUpdatesPerMonth: 4,
};

async function world(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `svc-${randomUUID()}` }).returning();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Shoji", email: `s-${userId}@example.test`, emailVerified: true });
  const [client] = await db.insert(schema.clients).values({
    organisationId: org!.id, name: "AMO Rendering", slug: `amo-${randomUUID()}`,
  }).returning();
  return { orgId: org!.id, userId, clientId: client!.id };
}

describe("what a package pays for", () => {
  it("reads each service from the quota that sells it", () => {
    expect([...servicesPaidFor(FULL)].sort()).toEqual(["ads", "blog", "gbp", "social"]);
    expect([...servicesPaidFor({ ...FULL, ads: false, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0 })]).toEqual(["social"]);
    expect(servicesPaidFor({ ...FULL, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0 }).size).toBe(0);
  });

  it("zeroes the quotas of every service that is not switched on, and touches nothing else", () => {
    const trimmed = includesForServices(FULL, new Set(["blog"]));
    expect(trimmed).toEqual({ ...FULL, ads: false, socialPostsPerMonth: 0, gbpUpdatesPerMonth: 0 });
    expect(FULL.socialPostsPerMonth).toBe(8);
  });

  it("maps every content channel to the service that owns it", () => {
    expect(SERVICE_FOR_CHANNEL).toEqual({ facebook: "social", instagram: "social", blog: "blog", gbp: "gbp" });
  });
});

describe("client services", () => {
  it("is all off for a client nobody has switched on, whatever they pay for", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await world(db);
      expect((await activeServicesForClient(db, orgId, clientId)).size).toBe(0);
      const listed = await listClientServices(db, orgId, clientId);
      expect(listed.map((row) => [row.service, row.active])).toEqual([
        ["ads", false], ["blog", false], ["social", false], ["gbp", false],
      ]);
    });
  });

  it("switches a service on and off, saying who did it, on the audit log and the client's timeline", async () => {
    await withTestDb(async (db) => {
      const { orgId, userId, clientId } = await world(db);

      const on = await setClientService(db, orgId, { clientId, service: "ads", active: true, actorKind: "user", actorId: userId });
      expect(on.changed).toBe(true);
      expect([...await activeServicesForClient(db, orgId, clientId)]).toEqual(["ads"]);

      const listed = await listClientServices(db, orgId, clientId);
      const ads = listed.find((row) => row.service === "ads")!;
      expect(ads).toMatchObject({ active: true, changedByUserId: userId, changedByName: "Shoji" });
      expect(ads.changedAt).toBeInstanceOf(Date);

      const off = await setClientService(db, orgId, { clientId, service: "ads", active: false, actorKind: "user", actorId: userId });
      expect(off.changed).toBe(true);
      expect((await activeServicesForClient(db, orgId, clientId)).size).toBe(0);

      const audit = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.targetType, "client_service"),
      ));
      expect(audit.map((row) => row.action).sort()).toEqual(["client_service.activated", "client_service.deactivated"]);
      expect(audit.every((row) => row.actorId === userId)).toBe(true);

      const timeline = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, clientId));
      expect(timeline.map((row) => row.title).sort()).toEqual(["Ads management switched off", "Ads management switched on"]);
    });
  });

  it("records nothing when the switch is already where it was asked to be", async () => {
    await withTestDb(async (db) => {
      const { orgId, userId, clientId } = await world(db);
      await setClientService(db, orgId, { clientId, service: "blog", active: true, actorKind: "user", actorId: userId });
      const again = await setClientService(db, orgId, { clientId, service: "blog", active: true, actorKind: "user", actorId: userId });
      expect(again.changed).toBe(false);
      const offWhenNeverOn = await setClientService(db, orgId, { clientId, service: "gbp", active: false, actorKind: "user", actorId: userId });
      expect(offWhenNeverOn.changed).toBe(false);

      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.organisationId, orgId));
      expect(audit.filter((row) => row.targetType === "client_service")).toHaveLength(1);
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const mine = await world(db);
      const theirs = await world(db);
      await expect(
        setClientService(db, mine.orgId, { clientId: theirs.clientId, service: "ads", active: true, actorKind: "user", actorId: mine.userId }),
      ).rejects.toThrow();
      expect((await activeServicesForClient(db, theirs.orgId, theirs.clientId)).size).toBe(0);
    });
  });

  it("lists the clients with a service switched on, and only in this organisation", async () => {
    await withTestDb(async (db) => {
      const a = await world(db);
      const [second] = await db.insert(schema.clients).values({
        organisationId: a.orgId, name: "Gateway Taxis", slug: `gw-${randomUUID()}`,
      }).returning();
      const other = await world(db);

      await setClientService(db, a.orgId, { clientId: a.clientId, service: "social", active: true, actorKind: "system" });
      await setClientService(db, a.orgId, { clientId: second!.id, service: "social", active: true, actorKind: "system" });
      await setClientService(db, a.orgId, { clientId: second!.id, service: "social", active: false, actorKind: "system" });
      await setClientService(db, other.orgId, { clientId: other.clientId, service: "social", active: true, actorKind: "system" });

      expect([...await clientIdsWithService(db, a.orgId, "social")]).toEqual([a.clientId]);
      expect((await clientIdsWithService(db, a.orgId, "ads")).size).toBe(0);
    });
  });
});
