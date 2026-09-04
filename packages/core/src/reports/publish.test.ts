import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildClientReport } from "./build-client-report.js";
import { publishClientReport } from "./publish.js";

async function draftReport(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `rep-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  const report = await buildClientReport(db, org!.id, client!.id, {
    start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z"),
  });
  return { orgId: org!.id, clientId: client!.id, reportId: report.id };
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
});
