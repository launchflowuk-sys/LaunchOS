import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { decideApproval } from "../approvals/decide-approval.js";
import { auditRows, contentFixture } from "../content/test-fixtures.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { isCourtesyNotice } from "../support/courtesy-notice.js";
import { buildMonthlyReport, renderMonthlyReport } from "./monthly-report.js";
import {
  ReportRefused, applyMonthlyReportSendDecision, monthlyReportSendDecided, requestMonthlyReportSend,
} from "./report-send.js";

afterEach(() => setEnqueue(async () => {}));

/** 07:45 on the 1st, London — the cron's own clock, reporting on August. */
const NOW = new Date("2026-09-01T06:45:00Z");

async function reportFor(db: Db, orgId: string, clientId: string) {
  const { report } = await buildMonthlyReport(db, orgId, { clientId, now: NOW });
  return report;
}

describe("monthly report send gate", () => {
  it("raises a report_send card, bells the owner, and refuses a second while one is pending", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const report = await reportFor(db, orgId, clientId);

      const { approval } = await requestMonthlyReportSend(db, orgId, { reportId: report.id });
      expect(approval.kind).toBe("report_send");
      expect(approval.title).toBe("Send Grays CabLine their August 2026 account report");
      expect(approval.payload).toMatchObject({
        action: "monthly_report_send", reportId: report.id, clientId, periodStart: "2026-08-01", monthName: "August 2026",
      });
      expect(await auditRows(db, orgId, "client_report.send_requested")).toHaveLength(1);

      const [bell] = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, "approval.requested"),
      ));
      expect(bell?.title).toBe("Approve: Grays CabLine's August 2026 account report");

      const again = await requestMonthlyReportSend(db, orgId, { reportId: report.id }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ReportRefused);
      expect((again as ReportRefused).reason).toBe("already_pending");
    });
  });

  it("refuses to raise a card for a client nobody could be emailed at", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      // No active portal user and no address on the client: approving it would
      // send nothing, so the card must never reach the queue.
      await db.update(schema.clientUsers).set({ status: "suspended" })
        .where(and(eq(schema.clientUsers.organisationId, orgId), eq(schema.clientUsers.clientId, clientId)));
      await db.update(schema.clients).set({ email: null })
        .where(and(eq(schema.clients.organisationId, orgId), eq(schema.clients.id, clientId)));
      const report = await reportFor(db, orgId, clientId);

      const refused = await requestMonthlyReportSend(db, orgId, { reportId: report.id }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ReportRefused);
      expect((refused as ReportRefused).reason).toBe("no_recipient");
      const cards = await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, orgId));
      expect(cards).toHaveLength(0);
    });
  });

  it("approving publishes the report and queues one branded email carrying the signed PDF link, once", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId } = await contentFixture(db);
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const built = await reportFor(db, orgId, clientId);
      const { document } = await renderMonthlyReport(db, orgId, { reportId: built.id });
      const { approval } = await requestMonthlyReportSend(db, orgId, { reportId: built.id });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });

      const result = await applyMonthlyReportSendDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(result).toMatchObject({ decision: "approved", reportId: built.id, alreadyApplied: false });
      expect(result.notices).toHaveLength(1);
      const notice = result.notices[0]!;
      expect(notice.status).toBe("queued");
      expect(notice.subject).toBe("Your account report for August 2026");
      expect(notice.metadata).toMatchObject({ kind: "client_report_notice", reportId: built.id, monthName: "August 2026", documentId: document.id });
      // The link is signed and expiring, so the body must carry the token and
      // never a bare `/api/documents/<id>` anyone could replay.
      expect(notice.body).toContain(`/api/documents/${document.id}?t=v1.`);
      expect(events).toContainEqual({ name: "message.queued", organisationId: orgId, messageId: notice.id });
      const hidden = await db.select().from(schema.messages).where(and(eq(schema.messages.id, notice.id), isCourtesyNotice()));
      expect(hidden).toHaveLength(1);

      const [published] = await db.select().from(schema.clientReports).where(eq(schema.clientReports.id, built.id));
      expect(published!.status).toBe("published");
      expect(published!.publishedAt).toBeInstanceOf(Date);

      const twice = await applyMonthlyReportSendDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(twice.alreadyApplied).toBe(true);
      expect(twice.notices).toHaveLength(0);
      const mail = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, orgId));
      expect(mail).toHaveLength(1);
    });
  });

  it("rejecting leaves the report a draft, emails nobody, and is remembered so the cron stops asking", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId } = await contentFixture(db);
      const built = await reportFor(db, orgId, clientId);
      const { approval } = await requestMonthlyReportSend(db, orgId, { reportId: built.id });
      expect(await monthlyReportSendDecided(db, orgId, built.id)).toBe(false);
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "rejected", decidedByUserId: ownerId });

      const result = await applyMonthlyReportSendDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(result).toMatchObject({ decision: "rejected", notices: [], alreadyApplied: false });
      const [still] = await db.select().from(schema.clientReports).where(eq(schema.clientReports.id, built.id));
      expect(still!.status).toBe("draft");
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, orgId))).toHaveLength(0);
      expect(await auditRows(db, orgId, "client_report.send_rejected")).toHaveLength(1);
      expect(await monthlyReportSendDecided(db, orgId, built.id)).toBe(true);
    });
  });

  it("will not raise or apply a send across organisations", async () => {
    await withTestDb(async (db) => {
      const mine = await contentFixture(db);
      const theirs = await contentFixture(db, { name: "Someone Else" });
      const report = await reportFor(db, theirs.orgId, theirs.clientId);

      await expect(requestMonthlyReportSend(db, mine.orgId, { reportId: report.id })).rejects.toThrow();

      const { approval } = await requestMonthlyReportSend(db, theirs.orgId, { reportId: report.id });
      await decideApproval(db, theirs.orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: theirs.ownerId });
      await expect(applyMonthlyReportSendDecision(db, mine.orgId, { approvalId: approval.id, actorId: mine.ownerId })).rejects.toThrow();
    });
  });
});
