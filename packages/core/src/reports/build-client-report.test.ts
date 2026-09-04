import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildClientReport, monthPeriod } from "./build-client-report.js";
import { publishClientReport } from "./publish.js";

const PERIOD = { start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") };

async function busyClient(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `rep-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  const [site] = await db.insert(schema.sites)
    .values({ organisationId: org!.id, clientId: client!.id, name: "S", primaryUrl: "https://s.test" }).returning();
  const [monitor] = await db.insert(schema.monitors)
    .values({ organisationId: org!.id, siteId: site!.id, target: "https://s.test" }).returning();

  await db.insert(schema.uptimeChecks).values([
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-05T00:00:00Z"), ok: true },
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-06T00:00:00Z"), ok: true },
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-07T00:00:00Z"), ok: true },
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-08-08T00:00:00Z"), ok: false },
    // Outside the period — must not count.
    { organisationId: org!.id, monitorId: monitor!.id, checkedAt: new Date("2026-09-05T00:00:00Z"), ok: false },
  ]);

  await db.insert(schema.tasks).values([
    { organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "social", title: "Post 1", status: "done", completedAt: new Date("2026-08-10T00:00:00Z") },
    { organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "content", title: "Post 2", status: "done", completedAt: new Date("2026-08-20T00:00:00Z") },
    { organisationId: org!.id, clientId: client!.id, phase: "recurring", kind: "seo", title: "Audit", status: "todo" },
  ]);

  await db.insert(schema.tickets).values([
    { organisationId: org!.id, clientId: client!.id, subject: "Opened in August", source: "portal", createdAt: new Date("2026-08-12T00:00:00Z") },
    { organisationId: org!.id, clientId: client!.id, subject: "Resolved in August", source: "portal", status: "resolved", createdAt: new Date("2026-08-13T00:00:00Z"), updatedAt: new Date("2026-08-14T00:00:00Z") },
  ]);

  await db.insert(schema.invoices).values([
    { organisationId: org!.id, clientId: client!.id, number: "LF-2026-0101", status: "paid", issuedAt: new Date("2026-08-01T00:00:00Z"), dueAt: new Date("2026-08-15T00:00:00Z"), subtotalPence: 10000, vatPence: 2000, totalPence: 12000 },
    { organisationId: org!.id, clientId: client!.id, number: "LF-2026-0102", status: "sent", issuedAt: new Date("2026-08-20T00:00:00Z"), dueAt: new Date("2026-09-03T00:00:00Z"), subtotalPence: 5000, vatPence: 1000, totalPence: 6000 },
  ]);

  return { orgId: org!.id, clientId: client!.id };
}

describe("monthPeriod", () => {
  it("returns the calendar month before now", () => {
    const period = monthPeriod(new Date("2026-09-01T05:00:00Z"));
    expect(period.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("buildClientReport", () => {
  it("collects tasks, uptime, tickets, ads and invoices into stats plus Markdown", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);

      const report = await buildClientReport(db, orgId, clientId, PERIOD);

      expect(report.status).toBe("draft");
      expect(report.periodStart).toBe("2026-08-01");
      expect(report.periodEnd).toBe("2026-08-31");
      expect(report.stats.tasksDone).toBe(2);
      expect(report.stats.tasksOpen).toBe(1);
      expect(report.stats.uptimePercent).toBeCloseTo(75, 1);
      expect(report.stats.ticketsOpened).toBe(2);
      expect(report.stats.ticketsResolved).toBe(1);
      expect(report.stats.ads).toBeNull();
      expect(report.stats.invoices).toEqual({ issued: 2, paidPence: 12000, outstandingPence: 6000 });
      expect(report.summaryMd).toContain("## Work delivered");
      expect(report.summaryMd).toContain("2 tasks completed");
    });
  });

  it("includes an ads section when the client has an ad account with data", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);
      const [account] = await db.insert(schema.adAccounts)
        .values({ organisationId: orgId, clientId, platform: "google", externalId: "a1", name: "Search" }).returning();
      await db.insert(schema.adMetricSnapshots).values([
        { organisationId: orgId, adAccountId: account!.id, date: "2026-08-10", spendPence: 10000, impressions: 900, clicks: 100, conversions: 5, conversionValuePence: 50000, cpcPence: 100, roas: 5 },
        { organisationId: orgId, adAccountId: account!.id, date: "2026-08-11", spendPence: 10000, impressions: 900, clicks: 100, conversions: 5, conversionValuePence: 30000, cpcPence: 100, roas: 3 },
      ]);

      const report = await buildClientReport(db, orgId, clientId, PERIOD);

      expect(report.stats.ads).toEqual({ spendPence: 20000, clicks: 200, conversions: 10, roas: 4 });
      expect(report.summaryMd).toContain("## Advertising");
    });
  });

  it("reports uptime as null, not zero, when there are no checks in the period", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `rep-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "No Checks Ltd", slug: `nc-${randomUUID()}` }).returning();
      // No site, no monitor, no uptime_checks rows at all for this client.

      const report = await buildClientReport(db, org!.id, client!.id, PERIOD);

      expect(report.stats.uptimePercent).toBeNull();
      expect(report.summaryMd).toContain("No uptime checks recorded for this period.");
    });
  });

  it("rebuilds the same period in place rather than duplicating it", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);
      const first = await buildClientReport(db, orgId, clientId, PERIOD);
      const second = await buildClientReport(db, orgId, clientId, PERIOD);
      expect(second.id).toBe(first.id);
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.clientId, clientId));
      expect(rows).toHaveLength(1);
    });
  });

  it("records a client_report.built audit row for each write, but not for a blocked rebuild", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);
      const builtAudits = () => db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, orgId),
        eq(schema.auditLog.action, "client_report.built"),
      ));

      const draft = await buildClientReport(db, orgId, clientId, PERIOD);
      expect(await builtAudits()).toHaveLength(1);

      // A second build of the still-draft report is a real write (upsert),
      // so it is audited again.
      await buildClientReport(db, orgId, clientId, PERIOD);
      expect(await builtAudits()).toHaveLength(2);

      // Once published, a rebuild is blocked entirely — no write, no audit.
      await publishClientReport(db, orgId, { reportId: draft.id, actorId: "u1" });
      await buildClientReport(db, orgId, clientId, PERIOD);
      expect(await builtAudits()).toHaveLength(2);
    });
  });

  it("leaves a published report untouched when rebuilt", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await busyClient(db);
      const draft = await buildClientReport(db, orgId, clientId, PERIOD);
      const published = await publishClientReport(db, orgId, { reportId: draft.id, actorId: "u1" });
      expect(published.status).toBe("published");
      expect(published.publishedAt).not.toBeNull();

      const rebuilt = await buildClientReport(db, orgId, clientId, PERIOD);
      expect(rebuilt.status).toBe("published");
    });
  });
});
