import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { EmailAdapter, SendResult } from "@launchos/channels";
import { MockEmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { createAdAccount } from "./accounts.js";
import { approveAdReport, saveDraftAdReport, sendAdReport } from "./reports.js";

const ENV = { MAIL_FROM: "LaunchFlow <reports@launchflow.test>" };
const PORTAL = "https://portal.test";

/** Always fails, to prove a failed send rolls the claim back to `approved`. */
class FailingEmailAdapter implements EmailAdapter {
  readonly name = "mock" as const;
  calls = 0;
  async send(): Promise<SendResult> {
    this.calls += 1;
    throw new Error("smtp connection refused");
  }
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

  it("rolls the claim back to approved when the send itself fails", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await orgClientAccount(db);
      const report = await draftReport(db, orgId, accountId);
      await approveAdReport(db, orgId, { adReportId: report.id, actorId: "u1" });
      const failing = new FailingEmailAdapter();

      await expect(sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, failing, PORTAL, ENV))
        .rejects.toThrow(/smtp connection refused/);
      expect(failing.calls).toBe(1);

      const [row] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(row!.status).toBe("approved");

      // A retry with a working adapter now succeeds, proving the report was
      // never left stuck in a half-sent state.
      const adapter = new MockEmailAdapter();
      const retried = await sendAdReport(db, orgId, { adReportId: report.id, actorId: "u1" }, adapter, PORTAL, ENV);
      expect(retried.status).toBe("sent");
      expect(adapter.sent).toHaveLength(1);
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
