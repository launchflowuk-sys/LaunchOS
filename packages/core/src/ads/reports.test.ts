import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { EmailAdapter, SendResult } from "@launchos/channels";
import { MockEmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { createAdAccount } from "./accounts.js";
import { approveAdReport, MAX_AD_REPORT_SUMMARY_CHARS, saveDraftAdReport, sendAdReport } from "./reports.js";

const ENV = { MAIL_FROM: "LaunchFlow <reports@launchflow.test>" };
const PORTAL = "https://portal.test";

/** Always fails, to prove a failed send keeps the claim and records the gap. */
class FailingEmailAdapter implements EmailAdapter {
  readonly name = "mock" as const;
  calls = 0;
  async send(): Promise<SendResult> {
    this.calls += 1;
    throw new Error("smtp connection refused");
  }
}

/** An owner to receive the failure notification. */
async function owner(db: Db, orgId: string) {
  const [user] = await db.insert(schema.user)
    .values({ id: `u-${randomUUID()}`, name: "Shoji", email: `${randomUUID()}@test.example` })
    .returning();
  await db.insert(schema.organisationMembers)
    .values({ organisationId: orgId, userId: user!.id, role: "owner", status: "active" });
  return user!;
}

async function orgClientAccount(db: Db, clientEmail: string | null = "client@test.example") {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `rep-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({
      organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}`,
      ...(clientEmail === null ? {} : { email: clientEmail }),
    }).returning();
  const account = await createAdAccount(db, org!.id, { clientId: client!.id, platform: "google", externalId: "acct-1", name: "Search" });
  return { orgId: org!.id, clientId: client!.id, accountId: account.id };
}

async function draftReport(db: Db, orgId: string, accountId: string) {
  return saveDraftAdReport(db, orgId, {
    adAccountId: accountId, periodStart: "2026-09-01", periodEnd: "2026-09-07", summaryMd: "Spend is up, ROAS is flat.",
  });
}

describe("sendAdReport", () => {
  it("refuses to send a report that is still a draft", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await orgClientAccount(db);
      const report = await draftReport(db, orgId, accountId);
      const adapter = new MockEmailAdapter();

      await expect(sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, adapter, PORTAL, ENV))
        .rejects.toThrow(/not approved/);
      expect(adapter.sent).toHaveLength(0);

      const [row] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(row!.status).toBe("draft");
    });
  });

  it("sends an approved report exactly once; a second call is a no-op and sends no second email", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await orgClientAccount(db);
      const report = await draftReport(db, orgId, accountId);
      await approveAdReport(db, orgId, { adReportId: report.id, actorId: "u1" });
      const adapter = new MockEmailAdapter();

      const sent = await sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, adapter, PORTAL, ENV);
      expect(sent.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]!.to).toBe("client@test.example");

      const second = await sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, adapter, PORTAL, ENV);
      expect(second).toMatchObject({ status: "sent", alreadySent: true });
      // The defining assertion: still exactly one email after the repeat call.
      expect(adapter.sent).toHaveLength(1);

      const [row] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(row!.status).toBe("sent");
    });
  });

  it("refuses a client with no email on file and leaves the report approved for retry", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await orgClientAccount(db, null);
      const report = await draftReport(db, orgId, accountId);
      await approveAdReport(db, orgId, { adReportId: report.id, actorId: "u1" });
      const adapter = new MockEmailAdapter();

      await expect(sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, adapter, PORTAL, ENV))
        .rejects.toThrow(/no email address/);
      expect(adapter.sent).toHaveLength(0);

      const [row] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(row!.status).toBe("approved");
    });
  });

  it("keeps the claim when the send fails, and records the gap rather than re-arming a second email", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, accountId } = await orgClientAccount(db);
      const user = await owner(db, orgId);
      const report = await draftReport(db, orgId, accountId);
      await approveAdReport(db, orgId, { adReportId: report.id, actorId: "u1" });
      const failing = new FailingEmailAdapter();

      await expect(sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, failing, PORTAL, ENV))
        .rejects.toThrow(/smtp connection refused/);
      expect(failing.calls).toBe(1);

      // The claim committed before the provider was called and stays taken: a
      // rollback here would re-arm a second email for the same report, and a
      // process killed between send and COMMIT would have emailed the client
      // while leaving the row `approved`.
      const [row] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(row!.status).toBe("sent");
      expect(row!.metadata["emailedAt"]).toBeUndefined();
      expect(row!.metadata["lastSendError"]).toMatchObject({
        to: "client@test.example",
        message: expect.stringContaining("smtp connection refused"),
      });

      // The failure is visible to a human in all three places.
      const activity = await db.select().from(schema.activityEvents)
        .where(eq(schema.activityEvents.clientId, clientId));
      expect(activity.map((a) => a.kind)).toContain("ad_report.send_failed");
      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.userId, user.id));
      expect(notifications.map((n) => n.kind)).toEqual(["ad_report.send_failed"]);

      // A retry is a no-op rather than a second email to the client.
      const adapter = new MockEmailAdapter();
      const retried = await sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, adapter, PORTAL, ENV);
      expect(retried).toMatchObject({ status: "sent", alreadySent: true });
      expect(adapter.sent).toHaveLength(0);
    });
  });

  it("confirms delivery and appends to the send history once the provider accepts", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await orgClientAccount(db);
      const report = await draftReport(db, orgId, accountId);
      await approveAdReport(db, orgId, { adReportId: report.id, actorId: "u1" });

      await sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, new MockEmailAdapter(), PORTAL, ENV);

      const [row] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      // `emailedAt` only exists once the provider took the message, so a report
      // sent with no `emailedAt` is the "claimed but never delivered" case.
      expect(typeof row!.metadata["emailedAt"]).toBe("string");
      expect(row!.metadata["sendHistory"]).toMatchObject([{ actorId: "u1", actorKind: "user" }]);
    });
  });
});

describe("approveAdReport", () => {
  it("refuses to approve a report that has already been sent", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await orgClientAccount(db);
      const report = await draftReport(db, orgId, accountId);
      await approveAdReport(db, orgId, { adReportId: report.id, actorId: "u1" });
      await sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, new MockEmailAdapter(), PORTAL, ENV);

      await expect(approveAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }))
        .rejects.toThrow(/already been sent/);
    });
  });
});

describe("saveDraftAdReport input", () => {
  it("refuses a summary past the ceiling and accepts one exactly on it", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await orgClientAccount(db);
      const period = { adAccountId: accountId, periodStart: "2026-09-01", periodEnd: "2026-09-07" };

      // The Sentinel writes this field, and nothing downstream bounds an LLM's
      // output — so a runaway generation has to be refused here rather than
      // stored and then rendered on every screen that shows the report.
      await expect(saveDraftAdReport(db, orgId, { ...period, summaryMd: "x".repeat(MAX_AD_REPORT_SUMMARY_CHARS + 1) }))
        .rejects.toThrow();
      await expect(saveDraftAdReport(db, orgId, { ...period, summaryMd: "" })).rejects.toThrow();

      const saved = await saveDraftAdReport(db, orgId, { ...period, summaryMd: "x".repeat(MAX_AD_REPORT_SUMMARY_CHARS) });
      expect(saved.summaryMd).toHaveLength(MAX_AD_REPORT_SUMMARY_CHARS);
    });
  });
});
