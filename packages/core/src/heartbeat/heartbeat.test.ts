import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { checkWorkerDown, noteSystemError, SYSTEM_ERRORS_NAME } from "./alerts.js";
import { heartbeatAge, recordHeartbeat, WORKER_HEARTBEAT_NAME } from "./heartbeat.js";

const MINUTE = 60_000;

async function seedOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `hb-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  return { orgId: org!.id, ownerId };
}

const kinds = (db: Db, orgId: string, kind: string) =>
  db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, kind)));

describe("heartbeat", () => {
  it("records, replaces details, and reports age", async () => {
    await withTestDb(async (db) => {
      const name = `probe-${randomUUID()}`;
      const t0 = new Date("2026-09-06T10:00:00Z");
      await recordHeartbeat(db, { name, details: { uptime: 1, queues: { a: 1 } }, now: t0 });
      const later = await recordHeartbeat(db, { name, details: { uptime: 61 }, now: new Date(t0.getTime() + MINUTE) });
      expect(later.details).toEqual({ uptime: 61 });
      const age = await heartbeatAge(db, { name, now: new Date(t0.getTime() + 3 * MINUTE) });
      expect(age).toEqual({ seenAt: new Date(t0.getTime() + MINUTE), ageMs: 2 * MINUTE, details: { uptime: 61 } });
      expect(await heartbeatAge(db, { name: `never-${randomUUID()}` })).toBeNull();
    });
  });

  it("worker down: banner without a notification when never seen; one notification per outage; re-arms after a fresh beat", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await seedOrg(db);
      // The worker row is global; within this rolled-back transaction it may already exist from a real worker, so overwrite it.
      const t0 = new Date("2026-09-06T10:00:00Z");
      await db.delete(schema.systemHeartbeats).where(eq(schema.systemHeartbeats.name, WORKER_HEARTBEAT_NAME));
      await db.delete(schema.systemHeartbeats).where(eq(schema.systemHeartbeats.name, "worker-down-alert"));
      expect(await checkWorkerDown(db, orgId, { now: t0 })).toEqual({ down: true, seenAt: null, ageMs: null, notified: false });

      await recordHeartbeat(db, { name: WORKER_HEARTBEAT_NAME, now: t0 });
      expect((await checkWorkerDown(db, orgId, { now: new Date(t0.getTime() + 2 * MINUTE) })).down).toBe(false);

      const first = await checkWorkerDown(db, orgId, { now: new Date(t0.getTime() + 7 * MINUTE) });
      expect(first).toMatchObject({ down: true, ageMs: 7 * MINUTE, notified: true });
      const second = await checkWorkerDown(db, orgId, { now: new Date(t0.getTime() + 9 * MINUTE) });
      expect(second).toMatchObject({ down: true, notified: false });
      const alerts = await kinds(db, orgId, "worker.down");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.title).toBe("Background worker has not checked in for 7 minutes");

      // Back, then gone again: a new outage, a new alert.
      const t1 = new Date(t0.getTime() + 10 * MINUTE);
      await recordHeartbeat(db, { name: WORKER_HEARTBEAT_NAME, now: t1 });
      expect((await checkWorkerDown(db, orgId, { now: new Date(t1.getTime() + MINUTE) })).down).toBe(false);
      expect((await checkWorkerDown(db, orgId, { now: new Date(t1.getTime() + 6 * MINUTE) })).notified).toBe(true);
      expect(await kinds(db, orgId, "worker.down")).toHaveLength(2);
    });
  });

  it("system errors: one notification per signature per hour, every active organisation unless one is named", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrg(db);
      const b = await seedOrg(db);
      await db.delete(schema.systemHeartbeats).where(eq(schema.systemHeartbeats.name, SYSTEM_ERRORS_NAME));
      const t0 = new Date("2026-09-06T10:00:00Z");
      const sig = `job:content.publish-due:TypeError-${randomUUID()}`;

      const first = await noteSystemError(db, { source: "worker", signature: sig, message: "x".repeat(2000), now: t0 });
      expect(first.notified).toBe(true);
      expect(first.notifiedOrganisations).toEqual(expect.arrayContaining([a.orgId, b.orgId]));
      const repeat = await noteSystemError(db, { source: "worker", signature: sig, message: "again", now: new Date(t0.getTime() + 30 * MINUTE) });
      expect(repeat).toEqual({ notified: false, notifiedOrganisations: [] });
      const other = await noteSystemError(db, { source: "web", signature: sig, message: "same text, other process", organisationId: a.orgId, now: t0 });
      expect(other.notifiedOrganisations).toEqual([a.orgId]);
      const later = await noteSystemError(db, { source: "worker", signature: sig, message: "an hour on", organisationId: a.orgId, now: new Date(t0.getTime() + 61 * MINUTE) });
      expect(later.notified).toBe(true);

      const forA = await kinds(db, a.orgId, "system.error");
      expect(forA).toHaveLength(3);
      expect(forA[0]!.body!.length).toBeLessThanOrEqual(500);
      expect(forA[0]!.title).toMatch(/^Worker error: job:content\.publish-due/);
      expect(await kinds(db, b.orgId, "system.error")).toHaveLength(1);

      const [row] = await db.select().from(schema.systemHeartbeats).where(eq(schema.systemHeartbeats.name, SYSTEM_ERRORS_NAME));
      expect((row!.details["signatures"] as Record<string, string>)[`worker:${sig}`]).toBe(new Date(t0.getTime() + 61 * MINUTE).toISOString());
      expect(row!.details["last"]).toMatchObject({ source: "worker", message: "an hour on" });
    });
  });
});
