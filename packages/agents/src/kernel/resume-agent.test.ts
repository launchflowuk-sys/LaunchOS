import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { FakeLlmClient, text, toolUse } from "./llm.js";
import { resumeAgent } from "./resume-agent.js";
import { runAgent } from "./run-agent.js";
import { defineTool, type AgentDefinition } from "./types.js";

const pingCalls: unknown[] = [];
const ping = defineTool({
  name: "ping",
  description: "ping",
  input: z.object({ host: z.string() }),
  risk: "safe",
  execute: async (input) => {
    pingCalls.push(input);
    return { ok: true };
  },
});
const sendMailCalls: unknown[] = [];
const sendMail = defineTool({
  name: "send_mail",
  description: "send",
  input: z.object({ to: z.string() }),
  risk: "requires_approval",
  execute: async (input) => {
    sendMailCalls.push(input);
    return { sent: true };
  },
});

const agent: AgentDefinition = {
  key: "test-agent",
  name: "Test",
  description: "",
  trigger: { kind: "manual" },
  systemPrompt: "You test.",
  tools: [ping, sendMail],
  maxTurns: 4,
};

async function park(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const llm = new FakeLlmClient([
    {
      content: [
        toolUse("tu_a", "ping", { host: "a.test" }),
        toolUse("tu_b", "send_mail", { to: "jo@c.test" }),
        toolUse("tu_c", "ping", { host: "b.test" }),
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  const run = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.runId));
  return { organisationId: org!.id, run, approval: approval! };
}

describe("resumeAgent", () => {
  beforeEach(() => {
    pingCalls.length = 0;
    sendMailCalls.length = 0;
  });

  it("executes the approved tool, skips the remaining tool uses and completes the run", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      expect(run.status).toBe("awaiting_approval");
      pingCalls.length = 0;

      const llm = new FakeLlmClient([
        { content: [text("Reply sent.")], stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 2 } },
      ]);
      const resumed = await resumeAgent(agent, {
        db,
        organisationId,
        runId: run.runId,
        approvalId: approval.id,
        decision: "approved",
        llm,
        policy: "safe",
        logger: console,
      });

      expect(resumed.status).toBe("completed");
      expect(resumed.runId).toBe(run.runId);
      expect(sendMailCalls).toEqual([{ to: "jo@c.test" }]);
      // The already-completed ping is replayed from metadata, not re-executed.
      expect(pingCalls).toEqual([]);

      const results = llm.requests[0]!.messages.at(-1)!.content as Array<{ tool_use_id: string; is_error?: boolean; content: unknown }>;
      expect(results.map((r) => r.tool_use_id)).toEqual(["tu_a", "tu_b", "tu_c"]);
      expect(results.find((r) => r.tool_use_id === "tu_c")!.is_error).toBe(true);
      expect(results.find((r) => r.tool_use_id === "tu_c")!.content).toBe("skipped pending approval");

      const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.runId));
      expect(row!.status).toBe("completed");
      expect(row!.finishedAt).toBeInstanceOf(Date);
      expect(row!.metadata).toEqual({});

      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, run.runId)).orderBy(schema.agentSteps.seq);
      expect(steps.map((s) => s.seq)).toEqual([...steps.keys()].map((i) => i + 1)); // seq continues, never restarts
      expect(steps.map((s) => s.kind)).toContain("tool_result");

      const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(decided!.status).toBe("approved");
      expect(decided!.decidedAt).toBeInstanceOf(Date);
    });
  });

  it("feeds a rejection back to the model instead of running the tool", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      const llm = new FakeLlmClient([
        { content: [text("Understood, escalating instead.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const resumed = await resumeAgent(agent, {
        db,
        organisationId,
        runId: run.runId,
        approvalId: approval.id,
        decision: "rejected",
        note: "Wrong tone",
        llm,
        policy: "safe",
        logger: console,
      });

      expect(resumed.status).toBe("completed");
      expect(sendMailCalls).toEqual([]);
      const results = llm.requests[0]!.messages.at(-1)!.content as Array<{ tool_use_id: string; is_error?: boolean; content: string }>;
      const rejected = results.find((r) => r.tool_use_id === "tu_b")!;
      expect(rejected.is_error).toBe(true);
      expect(rejected.content).toBe("rejected by human: Wrong tone");

      const [decided] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(decided!.status).toBe("rejected");
      expect(decided!.decisionNote).toBe("Wrong tone");
    });
  });

  it("refuses to resume a run that is not awaiting approval", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      await db.update(schema.agentRuns).set({ status: "completed" }).where(eq(schema.agentRuns.id, run.runId));
      await expect(
        resumeAgent(agent, {
          db,
          organisationId,
          runId: run.runId,
          approvalId: approval.id,
          decision: "approved",
          llm: new FakeLlmClient([]),
          policy: "safe",
          logger: console,
        }),
      ).rejects.toThrow(/awaiting_approval/);
    });
  });

  it("refuses to resume from a different organisation", async () => {
    await withTestDb(async (db) => {
      const { run, approval } = await park(db);
      const [other] = await db.insert(schema.organisations).values({ name: "O", slug: `o-${crypto.randomUUID()}` }).returning();
      await expect(
        resumeAgent(agent, {
          db,
          organisationId: other!.id,
          runId: run.runId,
          approvalId: approval.id,
          decision: "approved",
          llm: new FakeLlmClient([]),
          policy: "safe",
          logger: console,
        }),
      ).rejects.toThrow(/not found in organisation/);
    });
  });

  it("refuses to resume when the approved tool is not registered on the agent", async () => {
    await withTestDb(async (db) => {
      const { organisationId, run, approval } = await park(db);
      const pingOnly: AgentDefinition = { ...agent, tools: [ping] };
      await expect(
        resumeAgent(pingOnly, {
          db,
          organisationId,
          runId: run.runId,
          approvalId: approval.id,
          decision: "approved",
          llm: new FakeLlmClient([]),
          policy: "safe",
          logger: console,
        }),
      ).rejects.toThrow(/not registered/);
    });
  });
});
