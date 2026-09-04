import { describe, expect, it } from "vitest";
import { decideApproval } from "@launchos/core";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FakeLlmClient, defineTool, runAgent, text, toolUse, type AgentDefinition } from "@launchos/agents";
import { handleAgentResume } from "./agent-resume.js";

const sendMail = defineTool({
  name: "send_mail", description: "send", input: z.object({ to: z.string() }), risk: "requires_approval",
  execute: async () => ({ sent: true }),
});
const agent: AgentDefinition = {
  key: "test-agent", name: "Test", description: "", trigger: { kind: "manual" },
  systemPrompt: "You test.", tools: [sendMail], maxTurns: 3,
};

async function parked(db: Db, decision: "approved" | "rejected" = "approved", note?: string) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  await db.insert(schema.agentEnablement).values({ organisationId: org!.id, agentKey: "test-agent", enabled: true });
  const run = await runAgent(agent, {
    db, organisationId: org!.id, trigger: "manual", payload: {},
    llm: new FakeLlmClient([{ content: [toolUse("tu_1", "send_mail", { to: "jo@c.test" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }]),
    policy: "safe", logger: console,
  });
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.runId));
  // The portal records the decision before the job is queued; the kernel reads
  // the verdict, the note and the approver back off this row.
  await decideApproval(db, org!.id, {
    approvalId: approval!.id, decision, decidedByUserId: "u1", ...(note ? { note } : {}),
  });
  return { organisationId: org!.id, run, approval: approval! };
}

describe("handleAgentResume", () => {
  it("looks the agent up by the run's agentKey and resumes it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await parked(db);
      const llm = new FakeLlmClient([{ content: [text("Done.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }]);

      const result = await handleAgentResume(
        { db, registry: { "test-agent": agent }, llm, policy: "safe", logger: console },
        { organisationId, runId: run.runId, approvalId: approval.id, decision: "approved" },
      );

      expect(result!.status).toBe("completed");
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("completed");
    });
  });

  it("is a no-op when the run has already finished, so a pg-boss retry does not fail for ever", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await parked(db);
      await db.update(schema.agentRuns).set({ status: "completed" }).where(eq(schema.agentRuns.id, run.runId));

      // No scripted LLM response: reaching the kernel at all would throw.
      const result = await handleAgentResume(
        { db, registry: { "test-agent": agent }, llm: new FakeLlmClient([]), policy: "safe", logger: console },
        { organisationId, runId: run.runId, approvalId: approval.id, decision: "approved" },
      );

      expect(result).toBeUndefined();
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("completed");
    });
  });

  it("resumes even when the agent has since been disabled, because a human already decided", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await parked(db, "rejected", "no");
      await db.update(schema.agentEnablement).set({ enabled: false }).where(eq(schema.agentEnablement.organisationId, organisationId));
      const llm = new FakeLlmClient([{ content: [text("Done.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }]);

      const result = await handleAgentResume(
        { db, registry: { "test-agent": agent }, llm, policy: "safe", logger: console },
        { organisationId, runId: run.runId, approvalId: approval.id, decision: "rejected", note: "no" },
      );
      expect(result!.status).toBe("completed");
    });
  });
  it("is a no-op for a run an earlier delivery already failed, so the retry loop stops", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await parked(db);
      // `failStrandedRun` produces exactly this state, and the retry after it
      // must stop here rather than reach the kernel again.
      await db.update(schema.agentRuns).set({ status: "failed" }).where(eq(schema.agentRuns.id, run.runId));

      const result = await handleAgentResume(
        { db, registry: { "test-agent": agent }, llm: new FakeLlmClient([]), policy: "safe", logger: console },
        { organisationId, runId: run.runId, approvalId: approval.id, decision: "approved" },
      );

      expect(result).toBeUndefined();
    });
  });

  it("closes out a run an abandoned delivery left running", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await parked(db);
      const [before] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      // A delivery for this approval claimed the run ten minutes ago and died.
      // `running` is deliberately not skipped above: this is the one case the
      // kernel still has to end, or the run sits there for ever.
      await db.update(schema.agentRuns)
        .set({
          status: "running",
          metadata: {
            ...before!.metadata,
            resume: { approvalId: approval.id, claimedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
          },
        })
        .where(eq(schema.agentRuns.id, run.runId));

      const result = await handleAgentResume(
        { db, registry: { "test-agent": agent }, llm: new FakeLlmClient([]), policy: "safe", logger: console },
        { organisationId, runId: run.runId, approvalId: approval.id, decision: "approved" },
      );

      expect(result!.status).toBe("failed");
      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("failed");
      expect(row!.finishedAt).toBeInstanceOf(Date);
    });
  });
});
