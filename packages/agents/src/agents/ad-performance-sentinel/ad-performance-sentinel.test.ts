import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { createAdAccount, decideApproval, saveDraftAdReport } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import type { AgentDefinition } from "../../kernel/types.js";
import { resumeAgent } from "../../kernel/resume-agent.js";
import { runAgent } from "../../kernel/run-agent.js";
import { adPerformanceSentinel } from "./index.js";

const NOW = new Date("2026-09-15T07:00:00Z");
const PORTAL = "http://localhost:3000";
const usage = { inputTokens: 1, outputTokens: 1 };
const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);

/** An active account whose last 7 days halved its ROAS against the 7 before them. */
async function droppingAccount(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `sen-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}`, email: "info@grays.test" })
    .returning();
  const account = await createAdAccount(db, org!.id, {
    clientId: client!.id, platform: "google", externalId: "123-456-7890", name: "Grays CabLine — Search",
  });
  const rows: (typeof schema.adMetricSnapshots.$inferInsert)[] = [];
  for (let offset = 1; offset <= 14; offset++) {
    const roas = offset <= 7 ? 2.5 : 5;
    rows.push({
      organisationId: org!.id, adAccountId: account.id, date: day(offset),
      spendPence: 10_000, impressions: 5000, clicks: 160, conversions: 8,
      conversionValuePence: Math.round(10_000 * roas), cpcPence: 62.5, roas,
    });
  }
  await db.insert(schema.adMetricSnapshots).values(rows);
  return { orgId: org!.id, clientId: client!.id, accountId: account.id };
}

const draftReport = (db: Db, orgId: string, accountId: string) =>
  saveDraftAdReport(db, orgId, {
    adAccountId: accountId, periodStart: day(7), periodEnd: day(1),
    summaryMd: "## Advertising\nROAS fell from 5.00 to 2.50.",
  });

/** Parks a send on the approval gate and returns the run plus its pending approval. */
async function parkSend(db: Db, agent: AgentDefinition, orgId: string, adReportId: string) {
  const llm = new FakeLlmClient([
    { content: [toolUse("t1", "reports_send_to_client", { adReportId })], stopReason: "tool_use", usage },
    { content: [text("Sent the advertising summary to the client.")], stopReason: "end_turn", usage },
  ]);
  const parked = await runAgent(agent, {
    db, organisationId: orgId, trigger: "cron", payload: { now: NOW.toISOString(), adReportId },
    llm, policy: "safe", logger: console, now: () => NOW,
  });
  expect(parked.status).toBe("awaiting_approval");

  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.runId, parked.runId), eq(schema.approvals.status, "pending")));
  return { llm, parked, approval: approval! };
}

/**
 * Runs the send tool, approves the parked call, and returns the run result with
 * the tool's own output. The decision is recorded exactly as the admin portal
 * records it — `decideApproval` writes it, the kernel reads it back — so the
 * approver the tool sees is the one in the database. Without a named approver
 * the row is decided with none, which is how a policy that releases the tool
 * without a human looks.
 */
async function sendOnApproval(db: Db, agent: AgentDefinition, orgId: string, adReportId: string, decidedByUserId?: string) {
  const { llm, parked, approval } = await parkSend(db, agent, orgId, adReportId);
  if (decidedByUserId) {
    await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId });
  } else {
    await db.update(schema.approvals)
      .set({ status: "approved", decidedAt: NOW })
      .where(eq(schema.approvals.id, approval.id));
  }
  const result = await resumeAgent(agent, {
    db, organisationId: orgId, runId: parked.runId, approvalId: approval.id,
    decision: "approved", llm, policy: "safe", logger: console, now: () => NOW,
  });
  const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, parked.runId));
  const output = steps.find((s) => s.kind === "tool_result" && s.toolName === "reports_send_to_client")?.output;
  return { result, output, runId: parked.runId, approvalId: approval.id };
}

describe("ad-performance-sentinel", () => {
  it("reads signals, opens a ticket and drafts a report for a flagged account", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "ads_list_accounts", {})], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "ads_get_signals", { adAccountId: accountId })], stopReason: "tool_use", usage },
        {
          content: [toolUse("t3", "tickets_create", {
            clientId, subject: "ROAS down 50% on Grays CabLine — Search",
            body: "Last 7 days ROAS 2.50 vs 5.00 in the prior 7.", severity: "high", category: "ads",
          })],
          stopReason: "tool_use", usage,
        },
        {
          content: [toolUse("t4", "ads_save_draft_report", {
            adAccountId: accountId, periodStart: day(7), periodEnd: day(1),
            summaryMd: "## Advertising\nROAS fell from 5.00 to 2.50.",
          })],
          stopReason: "tool_use", usage,
        },
        { content: [text("Flagged one account, opened a ticket and drafted a report.")], stopReason: "end_turn", usage },
      ]);

      const result = await runAgent(agent, {
        db, organisationId: orgId, trigger: "cron", payload: { now: NOW.toISOString() },
        llm, policy: "safe", logger: console, now: () => NOW,
      });

      expect(result.status).toBe("completed");

      const tickets = await db.select().from(schema.tickets)
        .where(and(eq(schema.tickets.organisationId, orgId), eq(schema.tickets.category, "ads")));
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.source).toBe("agent");

      const reports = await db.select().from(schema.adReports).where(eq(schema.adReports.adAccountId, accountId));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.status).toBe("draft");
      expect(reports[0]!.agentRunId).toBe(result.runId);

      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId));
      const signalStep = steps.find((s) => s.kind === "tool_result" && s.toolName === "ads_get_signals");
      expect((signalStep!.output as { flagged: boolean }).flagged).toBe(true);
      const listStep = steps.find((s) => s.kind === "tool_result" && s.toolName === "ads_list_accounts");
      expect((listStep!.output as { id: string }[]).map((a) => a.id)).toEqual([accountId]);

      // The ticket is attributed to this agent, not to whichever agent defined the tool.
      const [audit] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.action, "ticket.created")));
      expect(audit!.actorId).toBe("ad-performance-sentinel");

      expect(email.sent).toHaveLength(0);
    });
  });

  it("parks the run for approval when it tries to send the report to the client", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "reports_send_to_client", { adReportId: randomUUID() })], stopReason: "tool_use", usage },
      ]);

      const result = await runAgent(agent, {
        db, organisationId: orgId, trigger: "cron", payload: { now: NOW.toISOString() },
        llm, policy: "safe", logger: console, now: () => NOW,
      });

      expect(result.status).toBe("awaiting_approval");
      const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, result.runId));
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.status).toBe("pending");
      expect(email.sent).toHaveLength(0);
    });
  });

  it("approves the draft and emails the client the portal link once a human approves the send", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const report = await draftReport(db, orgId, accountId);
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const sent = await sendOnApproval(db, agent, orgId, report.id);

      expect(sent.result.status).toBe("completed");
      expect(sent.output).toMatchObject({ adReportId: report.id, status: "sent" });
      const [after] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(after!.status).toBe("sent");
      expect(after!.sentAt).not.toBeNull();
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]!.to).toBe("info@grays.test");
      expect(email.sent[0]!.text).toContain(`${PORTAL}/portal/reports`);

      // The agent's key owns both writes: a human approved the tool call, but the agent acted.
      const audit = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.targetId, report.id)));
      expect(audit.find((a) => a.action === "ad_report.sent")!.actorKind).toBe("agent");
      expect(audit.some((a) => a.action === "ad_report.approved" && a.actorKind === "agent")).toBe(true);
    });
  });

  it("tells the approver what they are releasing: client, address, period and the whole summary", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const report = await draftReport(db, orgId, accountId);
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const { approval } = await parkSend(db, agent, orgId, report.id);

      // The card names the client and the period, not a bare UUID.
      expect(approval.title).toContain("Grays CabLine");
      expect(approval.title).toContain(day(7));
      const payload = approval.payload as { description?: { summary: string; details: Record<string, unknown> } };
      expect(payload.description!.summary).toContain("info@grays.test");
      expect(payload.description!.summary).toContain(`${PORTAL}/portal/reports`);
      // Every fact is read from our rows; only the summary is the agent's text,
      // and that is exactly what the human has to read before releasing it.
      expect(payload.description!.details).toMatchObject({
        client: "Grays CabLine",
        recipientEmail: "info@grays.test",
        adAccount: "Grays CabLine — Search",
        reportStatus: "draft",
        summaryMd: "## Advertising\nROAS fell from 5.00 to 2.50.",
      });
      expect(email.sent).toHaveLength(0);
    });
  });

  it("attributes the approval and the send to the human who released it", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const report = await draftReport(db, orgId, accountId);
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      await sendOnApproval(db, agent, orgId, report.id, "user_shoji");

      const audit = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.targetId, report.id)));
      const approved = audit.find((a) => a.action === "ad_report.approved")!;
      const sent = audit.find((a) => a.action === "ad_report.sent")!;
      expect([approved.actorKind, approved.actorId]).toEqual(["user", "user_shoji"]);
      expect([sent.actorKind, sent.actorId]).toEqual(["user", "user_shoji"]);
    });
  });

  it("does not email the client twice when the same approval is resumed again", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const report = await draftReport(db, orgId, accountId);
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const first = await sendOnApproval(db, agent, orgId, report.id);
      const [firstSend] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));

      // The real replay: the same run and the same approval, resumed a second
      // time — a doubled button press, or pg-boss redelivering the job.
      await expect(
        resumeAgent(agent, {
          db, organisationId: orgId, runId: first.runId, approvalId: first.approvalId,
          decision: "approved", llm: new FakeLlmClient([]), policy: "safe", logger: console, now: () => NOW,
        }),
      ).rejects.toThrow(/no resumable pending state/);
      // The approval is spent as well, so the kernel would refuse it twice over.
      const [spent] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, first.approvalId));
      expect(spent!.status).toBe("approved");
      expect(email.sent).toHaveLength(1);

      // And a fresh run approved against the same report is a no-op, not a resend.
      const second = await sendOnApproval(db, agent, orgId, report.id);
      expect(second.result.status).toBe("completed");
      expect(second.output).toMatchObject({ adReportId: report.id, status: "already_sent" });
      expect(email.sent).toHaveLength(1);
      const [after] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(after!.sentAt).toEqual(firstSend!.sentAt);
    });
  });

  it("refuses another organisation's report instead of approving or sending it", async () => {
    await withTestDb(async (db) => {
      const mine = await droppingAccount(db);
      const theirs = await droppingAccount(db);
      const foreign = await draftReport(db, theirs.orgId, theirs.accountId);
      const email = new MockEmailAdapter();
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const sent = await sendOnApproval(db, agent, mine.orgId, foreign.id);

      expect(sent.output).toMatchObject({ error: expect.stringMatching(/not found in organisation/) });
      expect(email.sent).toHaveLength(0);
      // The swallowed approve must not have touched the other organisation's row.
      const [row] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, foreign.id));
      expect(row!.status).toBe("draft");
    });
  });
});
