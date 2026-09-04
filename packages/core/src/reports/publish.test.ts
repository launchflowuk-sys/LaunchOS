import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { createDb, schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildClientReport } from "./build-client-report.js";
import { publishClientReport } from "./publish.js";

const PERIOD = { start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") };

async function seedClient(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `rep-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  return { orgId: org!.id, clientId: client!.id };
}

async function draftReport(db: Db) {
  const seeded = await seedClient(db);
  const report = await buildClientReport(db, seeded.orgId, seeded.clientId, PERIOD);
  return { ...seeded, reportId: report.id };
}

describe("publishClientReport", () => {
  it("sets status and publishedAt, and audits and records activity once", async () => {
    await withTestDb(async (db) => {
      const { orgId, reportId } = await draftReport(db);

      const published = await publishClientReport(db, orgId, { reportId, actorId: "u1" });

      expect(published.status).toBe("published");
      expect(published.publishedAt).not.toBeNull();

      const audits = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, orgId),
        eq(schema.auditLog.action, "client_report.published"),
        eq(schema.auditLog.targetId, reportId),
      ));
      expect(audits).toHaveLength(1);

      const activity = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.organisationId, orgId),
        eq(schema.activityEvents.kind, "client_report.published"),
      ));
      expect(activity).toHaveLength(1);
    });
  });

  it("is idempotent: a second publish is a no-op", async () => {
    await withTestDb(async (db) => {
      const { orgId, reportId } = await draftReport(db);

      const first = await publishClientReport(db, orgId, { reportId, actorId: "u1" });
      const second = await publishClientReport(db, orgId, { reportId, actorId: "u2" });

      expect(second.publishedAt?.toISOString()).toBe(first.publishedAt?.toISOString());

      const audits = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, orgId),
        eq(schema.auditLog.action, "client_report.published"),
        eq(schema.auditLog.targetId, reportId),
      ));
      expect(audits).toHaveLength(1);

      const activity = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.organisationId, orgId),
        eq(schema.activityEvents.kind, "client_report.published"),
      ));
      expect(activity).toHaveLength(1);
    });
  });

  // Real concurrency needs two connections, so this test cannot use
  // `withTestDb` (one rolled-back transaction on one connection). It runs
  // against a pooled handle and deletes its organisation afterwards — the
  // cascade takes the report, audit and activity rows with it.
  it("two concurrent publishes write exactly one audit row and one activity row", async () => {
    const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
    const db = createDb(url!);
    let orgId: string | undefined;
    try {
      // Seed first and record the organisation id straight away: if anything
      // below throws, the finally block still has an id to clean up with.
      const seeded = await seedClient(db);
      orgId = seeded.orgId;
      const report = await buildClientReport(db, seeded.orgId, seeded.clientId, PERIOD);
      const draft = { orgId: seeded.orgId, reportId: report.id };

      // Force the pool to open a second connection *before* the race: without
      // this the second publish spends its first milliseconds on a TCP and auth
      // handshake, by which time the first has already committed and the two
      // transactions never overlap.
      await Promise.all([
        db.execute(sql`select pg_sleep(0.05)`),
        db.execute(sql`select pg_sleep(0.05)`),
      ]);

      const [first, second] = await Promise.all([
        publishClientReport(db, draft.orgId, { reportId: draft.reportId, actorId: "u1" }),
        publishClientReport(db, draft.orgId, { reportId: draft.reportId, actorId: "u2" }),
      ]);

      const audits = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, draft.orgId),
        eq(schema.auditLog.action, "client_report.published"),
        eq(schema.auditLog.targetId, draft.reportId),
      ));
      expect(audits).toHaveLength(1);

      const activity = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.organisationId, draft.orgId),
        eq(schema.activityEvents.kind, "client_report.published"),
      ));
      expect(activity).toHaveLength(1);

      // Whichever transaction lost the race returns the winner's row unchanged:
      // no second `publishedAt` stamp.
      expect(first.status).toBe("published");
      expect(second.publishedAt?.toISOString()).toBe(first.publishedAt?.toISOString());
    } finally {
      if (orgId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
      await db.$client.end({ timeout: 5 });
    }
  });
});
