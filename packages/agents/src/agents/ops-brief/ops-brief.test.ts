import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { FakeLlmClient, text, toolUse } from "../../kernel/llm.js";
import { runAgent } from "../../kernel/run-agent.js";
import { OPS_BRIEF_HARD_MAX_WORDS } from "../../tools/ops-shared.js";
import { OPS_BRIEF_KEY, OPS_BRIEF_PROMPT, opsBrief } from "./index.js";

// 07:00 London on a September morning is 06:00 UTC; the brief's date is the London one.
const NOW = new Date("2026-09-09T06:00:00Z");
const HOUR = 3_600_000;
const usage = { inputTokens: 1, outputTokens: 1 };
const quiet = { info() {}, warn() {}, error() {} };

async function fixture(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `lf-${crypto.randomUUID()}` }).returning();
  const ownerId = crypto.randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner" });
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "Grays CabLine", slug: `gc-${crypto.randomUUID()}` }).returning();
  await db.insert(schema.tickets).values([
    { organisationId: org!.id, clientId: client!.id, subject: "Booking form broken", createdAt: new Date(NOW.getTime() - 3 * HOUR), firstResponseAt: new Date(NOW.getTime() - 2 * HOUR), status: "triaged" },
    { organisationId: org!.id, clientId: client!.id, subject: "Old one", createdAt: new Date(NOW.getTime() - 50 * HOUR), resolvedAt: new Date(NOW.getTime() - HOUR), status: "resolved" },
  ]);
  await db.insert(schema.approvals).values({ organisationId: org!.id, kind: "content_publish", title: "Publish: Airport fares", status: "pending", createdAt: new Date(NOW.getTime() - 2 * HOUR) });
  await db.insert(schema.activityEvents).values({
    organisationId: org!.id, clientId: client!.id, actorKind: "client", kind: "ticket.created", title: "Case opened: Booking form broken", link: "/cases/x", createdAt: new Date(NOW.getTime() - 3 * HOUR),
  });
  await db.insert(schema.timeEntries).values({ organisationId: org!.id, userId: ownerId, startedAt: new Date(NOW.getTime() - 9 * HOUR), endedAt: new Date(NOW.getTime() - HOUR) });
  // Two enquiries nobody has answered: one from yesterday morning (waiting over 24 h), one from an hour ago (not yet).
  await db.insert(schema.leads).values([
    { organisationId: org!.id, name: "Tilbury Taxis", source: "website", status: "new", createdAt: new Date(NOW.getTime() - 30 * HOUR) },
    { organisationId: org!.id, name: "Purfleet Salon", source: "website", status: "new", createdAt: new Date(NOW.getTime() - HOUR) },
  ]);
  return { orgId: org!.id, ownerId, clientId: client!.id };
}

const BODY = [
  "## Yesterday",
  "One case opened for Grays CabLine (booking form) and answered in 60 minutes; one older case resolved.",
  "## Needs you today",
  "- Approve 1 post — [Approvals](/approvals)",
  "## Team",
  "8 hours clocked; nobody is clocked in now.",
  "## Money",
  "Nothing paid, nothing outstanding.",
].join("\n");

describe("ops-brief", () => {
  it("reads the snapshot and the activity, saves the brief for today's London date with highlights, and completes", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "ops_metrics_snapshot", { hours: 24 })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "ops_recent_activity", { hours: 24, limit: 40 })], stopReason: "tool_use", usage },
        { content: [toolUse("t3", "ops_save_brief", { bodyMd: BODY, highlights: [{ label: "Approve 1 post", link: "/approvals" }] })], stopReason: "tool_use", usage },
        { content: [text("Brief saved.")], stopReason: "end_turn", usage },
      ]);

      const result = await runAgent(opsBrief(), {
        db, organisationId: f.orgId, trigger: "cron", payload: { now: NOW.toISOString() }, llm, policy: "safe", logger: quiet, now: () => NOW,
      });
      expect(result.status).toBe("completed");

      const briefs = await db.select().from(schema.opsBriefs).where(eq(schema.opsBriefs.organisationId, f.orgId));
      expect(briefs).toHaveLength(1);
      expect(briefs[0]).toMatchObject({ briefDate: "2026-09-09", bodyMd: BODY, agentRunId: result.runId });
      expect(briefs[0]!.highlights).toEqual([{ label: "Approve 1 post", link: "/approvals" }]);

      // The tools returned what the rows say: the snapshot and the timeline the model was given.
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId));
      const snapshot = steps.find((s) => s.kind === "tool_result" && s.toolName === "ops_metrics_snapshot")!.output as {
        cases: { opened: number; resolved: number; medianFirstResponseMinutes: number }; approvals: { pending: number }; team: { hoursClocked: number };
        leads: { awaitingReplyOver24h: number };
      };
      expect(snapshot.cases).toMatchObject({ opened: 1, resolved: 1, medianFirstResponseMinutes: 60 });
      expect(snapshot.approvals.pending).toBe(1);
      expect(snapshot.team.hoursClocked).toBe(8);
      // The brief's "N leads waiting for a reply over 24 h": the day-old enquiry counts, the hour-old one does not.
      expect(snapshot.leads.awaitingReplyOver24h).toBe(1);
      const activity = steps.find((s) => s.kind === "tool_result" && s.toolName === "ops_recent_activity")!.output as { timeline: { title: string; clientName: string }[] };
      expect(activity.timeline).toEqual([expect.objectContaining({ title: "Case opened: Booking form broken", clientName: "Grays CabLine" })]);
      const saved = steps.find((s) => s.kind === "tool_result" && s.toolName === "ops_save_brief")!.output as { saved: boolean; replaced: boolean; words: number };
      expect(saved).toMatchObject({ saved: true, replaced: false });

      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, f.orgId), eq(schema.auditLog.targetType, "ops_brief")));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "ops_brief.created", actorKind: "agent", actorId: OPS_BRIEF_KEY });

      // Every tool is safe, so approval_all is the only thing that could park it — and nothing is parked under `safe`.
      const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, result.runId));
      expect(run!.status).toBe("completed");
      expect(opsBrief().tools.every((t) => t.risk === "safe")).toBe(true);
    });
  });

  it("sends an over-long brief back to be trimmed, then replaces today's brief on the second save", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const tooLong = Array.from({ length: OPS_BRIEF_HARD_MAX_WORDS + 40 }, (_, i) => `word${i}`).join(" ");
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "ops_save_brief", { bodyMd: tooLong })], stopReason: "tool_use", usage },
        { content: [toolUse("t2", "ops_save_brief", { bodyMd: BODY })], stopReason: "tool_use", usage },
        { content: [toolUse("t3", "ops_save_brief", { bodyMd: `${BODY}\nRevised.` })], stopReason: "tool_use", usage },
        { content: [text("Brief saved.")], stopReason: "end_turn", usage },
      ]);
      const result = await runAgent(opsBrief(), {
        db, organisationId: f.orgId, trigger: "manual", payload: {}, llm, policy: "safe", logger: quiet, now: () => NOW,
      });
      expect(result.status).toBe("completed");

      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId));
      const outputs = steps.filter((s) => s.kind === "tool_result" && s.toolName === "ops_save_brief").map((s) => s.output as { saved: boolean; reason?: string; replaced?: boolean });
      expect(outputs[0]).toMatchObject({ saved: false });
      expect(outputs[0]!.reason).toMatch(/words/);
      expect(outputs[1]).toMatchObject({ saved: true, replaced: false });
      expect(outputs[2]).toMatchObject({ saved: true, replaced: true });

      const briefs = await db.select().from(schema.opsBriefs).where(eq(schema.opsBriefs.organisationId, f.orgId));
      expect(briefs).toHaveLength(1);
      expect(briefs[0]!.bodyMd).toBe(`${BODY}\nRevised.`);
    });
  });

  it("tells the model where the waiting-leads figure is and how to word it", () => {
    expect(OPS_BRIEF_PROMPT).toContain("leads.awaitingReplyOver24h");
    expect(OPS_BRIEF_PROMPT).toContain("[Leads](/leads?status=new)");
    expect(OPS_BRIEF_PROMPT).toContain("waiting for a reply over 24 h");
  });

  it("its tools see only the run's organisation", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const other = await fixture(db);
      const llm = new FakeLlmClient([
        { content: [toolUse("t1", "ops_metrics_snapshot", { hours: 24 })], stopReason: "tool_use", usage },
        { content: [text("Nothing to say.")], stopReason: "end_turn", usage },
      ]);
      await db.insert(schema.approvals).values({ organisationId: other.orgId, kind: "tool_call", title: "Theirs", status: "pending" });
      const result = await runAgent(opsBrief(), {
        db, organisationId: f.orgId, trigger: "cron", payload: {}, llm, policy: "safe", logger: quiet, now: () => NOW,
      });
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId));
      const snapshot = steps.find((s) => s.kind === "tool_result")!.output as { approvals: { pending: number } };
      // One in ours; the other organisation's pending approval is not counted.
      expect(snapshot.approvals.pending).toBe(1);
    });
  });
});
