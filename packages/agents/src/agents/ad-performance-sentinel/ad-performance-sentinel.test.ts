import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { createAdAccount, saveDraftAdReport } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
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
      const { orgId, accountId } = await droppingAccount(db);
      const email = new MockEmailAdapter();
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const llm = new FakeLlmClient([
        {
          content: [toolUse("t1", "reports_send_to_client", { adReportId: randomUUID(), adAccountId: accountId })],
          stopReason: "tool_use", usage,
        },
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

  it("emails the client the portal link once a human approves the send", async () => {
    await withTestDb(async (db) => {
      const { orgId, accountId } = await droppingAccount(db);
      const report = await saveDraftAdReport(db, orgId, {
        adAccountId: accountId, periodStart: day(7), periodEnd: day(1),
        summaryMd: "## Advertising\nROAS fell from 5.00 to 2.50.",
      });
      const email = new MockEmailAdapter();
      const agent = adPerformanceSentinel({ email, portalBaseUrl: PORTAL });

      const llm = new FakeLlmClient([
        {
          content: [toolUse("t1", "reports_send_to_client", { adReportId: report.id, adAccountId: accountId })],
          stopReason: "tool_use", usage,
        },
        { content: [text("Sent the advertising summary to the client.")], stopReason: "end_turn", usage },
      ]);

      const parked = await runAgent(agent, {
        db, organisationId: orgId, trigger: "cron", payload: { now: NOW.toISOString(), adReportId: report.id },
        llm, policy: "safe", logger: console, now: () => NOW,
      });
      expect(parked.status).toBe("awaiting_approval");
      expect(email.sent).toHaveLength(0);

      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, parked.runId));
      const resumed = await resumeAgent(agent, {
        db, organisationId: orgId, runId: parked.runId, approvalId: approval!.id,
        decision: "approved", llm, policy: "safe", logger: console, now: () => NOW,
      });

      expect(resumed.status).toBe("completed");
      const [after] = await db.select().from(schema.adReports).where(eq(schema.adReports.id, report.id));
      expect(after!.status).toBe("sent");
      expect(after!.sentAt).not.toBeNull();
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]!.to).toBe("info@grays.test");
      expect(email.sent[0]!.text).toContain(`${PORTAL}/portal/reports`);
    });
  });
});
