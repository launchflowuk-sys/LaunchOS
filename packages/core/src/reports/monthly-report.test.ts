import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { tinyPdf } from "@launchos/channels/pdf";
import { setEnqueue } from "../events/emit.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { documentBodyFromMarkdown } from "./markdown-document.js";
import { buildMonthlyReport, londonMonthPeriod, renderMonthlyReport, reportMonthName } from "./monthly-report.js";
import { publishClientReport } from "./publish.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-monthly-"));
const ENV = { STORAGE_DIR: storage, APP_URL: "https://os.launchflow.test" };
const DEPS = { render: async () => tinyPdf("Report") };
/** 07:45 on 1 September, Europe/London — when the cron runs. */
const CRON = new Date("2026-09-01T06:45:00Z");

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

async function busyAugust(db: Db) {
  const seeded = await seedOrgWithClient(db);
  const { organisationId, clientId } = seeded;
  const [site] = await db.insert(schema.sites).values({
    organisationId, clientId, name: "S", primaryUrl: "https://s.test",
  }).returning();
  await db.insert(schema.incidents).values([
    { organisationId, siteId: site!.id, title: "Site down", openedAt: new Date("2026-08-04T02:00:00Z"), resolvedAt: new Date("2026-08-04T03:00:00Z"), status: "resolved" },
    { organisationId, siteId: site!.id, title: "Still down", openedAt: new Date("2026-08-30T02:00:00Z"), status: "open" },
    // July's, resolved in July: neither raised nor resolved in August.
    { organisationId, siteId: site!.id, title: "July", openedAt: new Date("2026-07-04T02:00:00Z"), resolvedAt: new Date("2026-07-04T03:00:00Z"), status: "resolved" },
  ]);
  const [ticket] = await db.insert(schema.tickets).values({
    organisationId, clientId, subject: "Broken form", source: "portal", status: "resolved",
    createdAt: new Date("2026-08-10T09:00:00Z"), resolvedAt: new Date("2026-08-11T09:00:00Z"),
  }).returning();
  await db.insert(schema.ticketRatings).values({
    organisationId, ticketId: ticket!.id, score: 5, ratedAt: new Date("2026-08-12T09:00:00Z"),
  });
  await db.insert(schema.contentReports).values({
    organisationId, clientId, periodKey: "2026-08", summaryMd: "# content",
    stats: { published: 6, planned: 7, byChannel: { facebook: 3, instagram: 3, blog: 0, gbp: 0 }, items: [] },
  });
  await db.insert(schema.payments).values({
    organisationId, clientId, amountPence: 30_000, provider: "stripe", providerRef: `pi_${randomUUID()}`,
    status: "succeeded", paidAt: new Date("2026-08-02T09:00:00Z"),
  });
  return seeded;
}

describe("londonMonthPeriod", () => {
  it("is the previous calendar month in London, not in UTC", () => {
    // British Summer Time: August starts at 23:00 UTC on 31 July, and the UTC
    // version of this would take an hour of September into August's figures.
    const august = londonMonthPeriod(CRON);
    expect(august.start.toISOString()).toBe("2026-07-31T23:00:00.000Z");
    expect(august.end.toISOString()).toBe("2026-08-31T23:00:00.000Z");
    expect(reportMonthName(august)).toBe("August 2026");

    // And in the winter, where London is UTC, the two agree exactly.
    const december = londonMonthPeriod(new Date("2027-01-01T06:45:00Z"));
    expect(december.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(december.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(reportMonthName(december)).toBe("December 2026");
  });
});

describe("buildMonthlyReport", () => {
  it("compiles last month through the existing client report, with the four new figures", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await busyAugust(db);

      const { report, monthName } = await buildMonthlyReport(db, organisationId, { clientId, now: CRON });

      expect(monthName).toBe("August 2026");
      expect(report.periodStart).toBe("2026-08-01");
      expect(report.periodEnd).toBe("2026-08-31");
      expect(report.stats.incidents).toEqual({ opened: 2, resolved: 1, openAtPeriodEnd: 1 });
      expect(report.stats.satisfaction).toEqual({ responses: 1, averageScore: 5 });
      expect(report.stats.content).toEqual({ published: 6, planned: 7 });
      expect(report.stats.payments).toEqual({ received: 1, receivedPence: 30_000 });
      // And they reach the summary the document is printed from.
      expect(report.summaryMd).toContain("## Incidents");
      expect(report.summaryMd).toContain("## Content");
      expect(report.summaryMd).toContain("Rated 5 out of 5");
      expect(report.summaryMd).toContain("£300.00 received");
    });
  });

  it("reports nothing rather than zero where a client has no content plan", async () => {
    await withTestDb(async (db) => {
      const seeded = await seedOrgWithClient(db);

      const { report } = await buildMonthlyReport(db, seeded.organisationId, { clientId: seeded.clientId, now: CRON });

      // "No content report exists" is a different statement from "we published
      // nothing for you", and only one of them is true here.
      expect(report.stats.content).toBeNull();
      expect(report.stats.satisfaction).toBeNull();
      expect(report.summaryMd).not.toContain("## Content");
    });
  });
});

describe("documentBodyFromMarkdown", () => {
  it("renders the constructs our generators emit, and escapes everything else", () => {
    const html = documentBodyFromMarkdown([
      "# Grays CabLine — August 2026",
      "",
      "## Work delivered",
      "- 2 tasks completed",
      "- [View post](https://example.test/p?a=1&b=2)",
      "",
      "A closing line with <script>alert(1)</script> in it.",
    ].join("\n"));

    // The `#` heading is dropped: the letterhead already prints the title.
    expect(html).not.toContain("Grays CabLine — August 2026");
    expect(html).toContain("<h2>Work delivered</h2>");
    expect(html).toContain("<li>2 tasks completed</li>");
    expect(html).toContain(`<a href="https://example.test/p?a=1&amp;b=2">View post</a>`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderMonthlyReport", () => {
  it("renders the row onto the letterhead and files the PDF against it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await busyAugust(db);
      const { report } = await buildMonthlyReport(db, organisationId, { clientId, now: CRON });

      const rendered = await renderMonthlyReport(db, organisationId, { reportId: report.id }, DEPS, ENV);

      expect(rendered.document.kind).toBe("monthly_report");
      expect(rendered.document.subjectType).toBe("client_report");
      expect(rendered.document.subjectId).toBe(report.id);
      expect(rendered.document.reference).toContain("R-2026-08-");
      expect(rendered.report.documentId).toBe(rendered.document.id);

      // A draft follows the row, so a correction is re-rendered...
      const again = await renderMonthlyReport(db, organisationId, { reportId: report.id }, DEPS, ENV);
      expect(again.document.id).not.toBe(rendered.document.id);

      // ...but the file a published report was sent with is the file it keeps.
      await publishClientReport(db, organisationId, { reportId: report.id, actorId: ownerUserId });
      const published = await renderMonthlyReport(db, organisationId, { reportId: report.id }, DEPS, ENV);
      expect(published.document.id).toBe(again.document.id);

      const audits = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, organisationId),
        eq(schema.auditLog.action, "client_report.rendered"),
      ));
      expect(audits).toHaveLength(2);
    });
  });

  it("will not render another organisation's report", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await busyAugust(db);
      const { report } = await buildMonthlyReport(db, organisationId, { clientId, now: CRON });
      const [other] = await db.insert(schema.organisations)
        .values({ name: "Other", slug: `o-${randomUUID()}` }).returning();

      await expect(renderMonthlyReport(db, other!.id, { reportId: report.id }, DEPS, ENV)).rejects.toThrow();
      await expect(buildMonthlyReport(db, other!.id, { clientId, now: CRON })).rejects.toThrow();
    });
  });
});
