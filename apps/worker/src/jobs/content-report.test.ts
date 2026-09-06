import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CONTENT_REPORT_SEND_ACTION } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { previousPeriodKey, runContentReports } from "./content-report.js";
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

function sendApprovals(db: Parameters<typeof runContentReports>[0], orgId: string) {
  return db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.organisationId, orgId), eq(schema.approvals.kind, CONTENT_REPORT_SEND_ACTION)));
}

function bells(db: Parameters<typeof runContentReports>[0], orgId: string) {
  return db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, "approval.requested")));
}

describe("previousPeriodKey", () => {
  it("steps back a month, across the year end", () => {
    expect(previousPeriodKey("2026-10")).toBe("2026-09");
    expect(previousPeriodKey("2026-01")).toBe("2025-12");
  });
});

describe("runContentReports", () => {
  it("builds last month's report for every client with published content and asks the owner to send it, once", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const quiet = await addClient(db, f.orgId, { name: "Nothing published" });
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-09-12T09:00:00Z"));
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-09-19T09:00:00Z"));
      await approvedItem(db, f.orgId, f.clientId, "gbp", new Date("2026-09-25T09:00:00Z"), { body: "Never went out" });
      // A slot planned in September but published in October counts for September.
      await approvedItem(db, f.orgId, quiet.clientId, "facebook", new Date("2026-09-03T09:00:00Z"));

      const result = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });

      expect(result).toEqual({ periodKey: PERIOD, clients: 1, reports: 1, requested: 1, failed: 0 });
      const reports = await db.select().from(schema.contentReports).where(eq(schema.contentReports.organisationId, f.orgId));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ clientId: f.clientId, periodKey: PERIOD, status: "draft" });
      expect(reports[0]!.stats).toMatchObject({ published: 2, planned: 3 });

      // The send is an approval card, not a bare bell: approving it emails the client.
      const [approval] = await sendApprovals(db, f.orgId);
      expect(approval).toMatchObject({ status: "pending", runId: null });
      expect(approval!.payload).toMatchObject({
        action: CONTENT_REPORT_SEND_ACTION, reportId: reports[0]!.id, clientId: f.clientId, clientName: "Grays CabLine",
        periodKey: PERIOD, published: 2, planned: 3, requestedByKind: "system",
      });
      expect(approval!.title).toContain("Grays CabLine");
      expect(approval!.title).toContain("2 of 3");
      // The owner is told, urgently.
      const [bell] = await bells(db, f.orgId);
      expect(bell).toMatchObject({ userId: f.ownerId, link: "/approvals" });

      // Re-running rebuilds the draft but does not raise a second card or ring again.
      const again = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });
      expect(again).toMatchObject({ reports: 1, requested: 0, failed: 0 });
      expect(await sendApprovals(db, f.orgId)).toHaveLength(1);
      expect(await bells(db, f.orgId)).toHaveLength(1);
    });
  });

  it("does nothing for an organisation with no published content last month", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-08-12T09:00:00Z"));
      const result = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });
      expect(result).toEqual({ periodKey: PERIOD, clients: 0, reports: 0, requested: 0, failed: 0 });
      expect(await sendApprovals(db, f.orgId)).toHaveLength(0);
    });
  });

  it("leaves a sent report alone, and does not ask again about a send the owner rejected", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      await publishedItem(db, f.orgId, f.clientId, new Date("2026-09-12T09:00:00Z"));
      await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });

      // Rejected: the report stays a draft, and the next run must not nag.
      await db.update(schema.approvals).set({ status: "rejected", decidedAt: NOW, decidedBy: f.ownerId })
        .where(eq(schema.approvals.organisationId, f.orgId));
      const afterReject = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });
      expect(afterReject).toMatchObject({ reports: 1, requested: 0 });
      expect(await sendApprovals(db, f.orgId)).toHaveLength(1);

      // Sent: the summary is frozen and nothing is asked.
      await db.update(schema.contentReports).set({ status: "sent", sentAt: NOW, summaryMd: "as sent" })
        .where(eq(schema.contentReports.organisationId, f.orgId));
      const afterSent = await runContentReports(db, f.orgId, { now: NOW, logger: silentLogger() });
      expect(afterSent).toMatchObject({ reports: 1, requested: 0 });
      const [report] = await db.select().from(schema.contentReports).where(eq(schema.contentReports.organisationId, f.orgId));
      expect(report!.summaryMd).toBe("as sent");
      expect(await sendApprovals(db, f.orgId)).toHaveLength(1);
    });
  });
});
