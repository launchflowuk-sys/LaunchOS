import { afterEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { decideApproval } from "../approvals/decide-approval.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { isCourtesyNotice } from "../support/courtesy-notice.js";
import { createContentItem } from "./items.js";
import { claimDueContent, markContentPublished } from "./publishing.js";
import { requestContentApproval, applyContentPublishDecision } from "./approval.js";
import { buildContentReport } from "./report.js";
import { applyContentReportSendDecision, contentReportEmailBody, requestContentReportSend } from "./report-send.js";
import { ContentRefused } from "./shared.js";
import { auditRows, contentFixture } from "./test-fixtures.js";

afterEach(() => setEnqueue(async () => {}));

async function publishedReport(db: Db, orgId: string, clientId: string, ownerId: string) {
  const item = await createContentItem(db, orgId, {
    clientId, channel: "facebook", periodKey: "2026-08", title: "Summer offer", body: "Book now",
    scheduledFor: new Date("2026-08-12T09:00:00Z"), actorKind: "user", actorId: ownerId,
  });
  const { approval } = await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId });
  await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });
  await applyContentPublishDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
  const [claimed] = await claimDueContent(db, orgId, { now: new Date("2026-08-12T10:00:00Z") });
  await markContentPublished(db, orgId, { itemId: claimed!.id, externalId: "fb_1", externalUrl: "https://facebook.com/p/1" });
  return buildContentReport(db, orgId, { clientId, periodKey: "2026-08" });
}

describe("content report send", () => {
  it("requests an approval with the summary, bells the owner urgently, refuses a second pending request", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId } = await contentFixture(db);
      const report = await publishedReport(db, orgId, clientId, ownerId);
      const { approval } = await requestContentReportSend(db, orgId, { reportId: report.id, actorKind: "user", actorId: ownerId });
      expect(approval.kind).toBe("content_report_send");
      expect(approval.title).toBe("Send Grays CabLine their August 2026 content report: 1 of 1 planned posts published");
      expect(approval.payload).toMatchObject({ action: "content_report_send", reportId: report.id, clientId, periodKey: "2026-08", monthName: "August 2026", published: 1 });

      const [bell] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, "approval.requested")));
      expect(bell?.title).toBe("Approve: Grays CabLine's August 2026 content report");
      expect((await auditRows(db, orgId, "content_report.send_requested"))).toHaveLength(1);

      const again = await requestContentReportSend(db, orgId, { reportId: report.id }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ContentRefused);
      expect((again as ContentRefused).reason).toBe("already_pending");
    });
  });

  it("approving sends one branded email per portal user, marks the report sent, once only; the report is then frozen", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId } = await contentFixture(db);
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const report = await publishedReport(db, orgId, clientId, ownerId);
      const { approval } = await requestContentReportSend(db, orgId, { reportId: report.id });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });

      const result = await applyContentReportSendDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(result.decision).toBe("approved");
      expect(result.alreadyApplied).toBe(false);
      expect(result.notices).toHaveLength(1);
      const notice = result.notices[0]!;
      expect(notice.status).toBe("queued");
      expect(notice.toEmail).toMatch(/@grays\.test$/);
      expect(notice.subject).toBe("Your content for August 2026");
      expect(notice.body).toMatch(/\d+ \w{3} — Facebook post: Summer offer — https:\/\/facebook\.com\/p\/1/);
      expect(notice.metadata).toMatchObject({ kind: "content_report_notice", reportId: report.id, monthName: "August 2026" });
      expect(events).toContainEqual({ name: "message.queued", organisationId: orgId, messageId: notice.id });
      const hidden = await db.select().from(schema.messages).where(and(eq(schema.messages.id, notice.id), isCourtesyNotice()));
      expect(hidden).toHaveLength(1);

      const [sent] = await db.select().from(schema.contentReports).where(eq(schema.contentReports.id, report.id));
      expect(sent!.status).toBe("sent");
      expect(sent!.sentAt).toBeInstanceOf(Date);

      const twice = await applyContentReportSendDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(twice.alreadyApplied).toBe(true);
      expect(twice.notices).toHaveLength(0);

      const rerequest = await requestContentReportSend(db, orgId, { reportId: report.id }).catch((e: unknown) => e);
      expect((rerequest as ContentRefused).reason).toBe("already_sent");
    });
  });

  it("rejecting leaves the report a draft and emails nobody", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId, clientId } = await contentFixture(db);
      const report = await publishedReport(db, orgId, clientId, ownerId);
      const { approval } = await requestContentReportSend(db, orgId, { reportId: report.id });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "rejected", decidedByUserId: ownerId, note: "Wait for the blog" });
      const result = await applyContentReportSendDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(result).toMatchObject({ decision: "rejected", notices: [], alreadyApplied: false });
      const [draft] = await db.select().from(schema.contentReports).where(eq(schema.contentReports.id, report.id));
      expect(draft!.status).toBe("draft");
      expect(await auditRows(db, orgId, "content_report.send_rejected")).toHaveLength(1);
      // A fresh request is allowed once the first is decided.
      const second = await requestContentReportSend(db, orgId, { reportId: report.id });
      expect(second.approval.status).toBe("pending");
    });
  });

  it("renders an empty month honestly and refuses across organisations", async () => {
    await withTestDb(async (db) => {
      const a = await contentFixture(db);
      const b = await contentFixture(db, { name: "Other" });
      const body = contentReportEmailBody({ periodKey: "2026-08", stats: { published: 0, planned: 2, byChannel: { facebook: 0, instagram: 0, blog: 0, gbp: 0 }, items: [] } }, "Grays CabLine");
      expect(body).toContain("Nothing went out for you in August 2026");
      const report = await publishedReport(db, a.orgId, a.clientId, a.ownerId);
      await expect(requestContentReportSend(db, b.orgId, { reportId: report.id })).rejects.toThrow(/not found in organisation/);
      const { approval } = await requestContentReportSend(db, a.orgId, { reportId: report.id });
      await decideApproval(db, a.orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: a.ownerId });
      await expect(applyContentReportSendDecision(db, b.orgId, { approvalId: approval.id, actorId: b.ownerId })).rejects.toThrow(/not found in organisation/);
    });
  });
});
