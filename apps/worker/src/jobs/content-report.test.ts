import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { CONTENT_REPORT_NOTIFICATION_KIND, contentReportLink, previousPeriodKey, runContentReports } from "./content-report.js";
import { addClient, approvedItem, contentJobFixture, silentLogger } from "./content-test-fixture.js";

// 07:00 London on 1 October 2026: the report is for September.
const NOW = new Date("2026-10-01T06:00:00Z");
const PERIOD = "2026-09";

async function publishedItem(db: Parameters<typeof runContentReports>[0], orgId: string, clientId: string, scheduledFor: Date) {
  const item = await approvedItem(db, orgId, clientId, "facebook", scheduledFor, { title: "Airport runs" });
  await db.update(schema.contentItems)
    .set({ status: "published", publishedAt: scheduledFor, externalUrl: "https://www.facebook.com/1/posts/1" })
    .where(eq(schema.contentItems.id, item.id));
  return item;
}

function notices(db: Parameters<typeof runContentReports>[0], orgId: string) {
  return db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, CONTENT_REPORT_NOTIFICATION_KIND)));
}

describe("previousPeriodKey", () => {
  it("steps back a month, across the year end", () => {
    expect(previousPeriodKey("2026-10")).toBe("2026-09");
    expect(previousPeriodKey("2026-01")).toBe("2025-12");
  });
});

describe("runContentReports", () => {
  it("builds last month's report for every client with published content and tells the owner once", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const quiet = await addClient(db, f.orgId, { name: "Nothing published" });
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-09-12T09:00:00Z"));
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-09-19T09:00:00Z"));
      await approvedItem(db, f.orgId, f.clientId, "gbp", new Date("2026-09-25T09:00:00Z"), { body: "Never went out" });
      // A slot planned in September but published in October counts for September.
      await approvedItem(db, f.orgId, quiet.clientId, "facebook", new Date("2026-09-03T09:00:00Z"));

      const result = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });

      expect(result).toEqual({ periodKey: PERIOD, clients: 1, reports: 1, notified: 1, failed: 0 });
      const reports = await db.select().from(schema.contentReports).where(eq(schema.contentReports.organisationId, f.orgId));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ clientId: f.clientId, periodKey: PERIOD, status: "draft" });
      expect(reports[0]!.stats).toMatchObject({ published: 2, planned: 3 });
      expect(reports[0]!.summaryMd).toContain("2 of 3 planned posts published");

      const [notice] = await notices(db, f.orgId);
      expect(notice).toMatchObject({
        userId: f.ownerId,
        title: "Content report ready: Grays CabLine, September 2026",
        link: contentReportLink(f.clientId, PERIOD),
      });
      expect(notice!.body).toContain("2 of 3");

      // Re-running rebuilds the draft but does not ring the bell again.
      const again = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });
      expect(again).toMatchObject({ reports: 1, notified: 0 });
      expect(await notices(db, f.orgId)).toHaveLength(1);
    });
  });

  it("does nothing for an organisation with no published content last month", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-08-12T09:00:00Z"));
      const result = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });
      expect(result).toEqual({ periodKey: PERIOD, clients: 0, reports: 0, notified: 0, failed: 0 });
      expect(await notices(db, f.orgId)).toHaveLength(0);
    });
  });

  it("leaves a sent report alone and does not announce it again", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-09-12T09:00:00Z"));
      await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });
      await db.update(schema.contentReports).set({ status: "sent", sentAt: NOW, summaryMd: "as sent" })
        .where(eq(schema.contentReports.organisationId, f.orgId));
      await db.delete(schema.notifications).where(eq(schema.notifications.organisationId, f.orgId));

      const result = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });

      expect(result).toMatchObject({ reports: 1, notified: 0 });
      const [report] = await db.select().from(schema.contentReports).where(eq(schema.contentReports.organisationId, f.orgId));
      expect(report!.summaryMd).toBe("as sent");
    });
  });
});
