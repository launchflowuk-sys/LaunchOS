import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { FakeLlmClient, text, toolUse } from "./llm.js";
import { runAgent } from "./run-agent.js";
import { defineTool, type AgentDefinition } from "./types.js";

const calls: unknown[] = [];
const ping = defineTool({ name: "ping", description: "ping", input: z.object({ host: z.string() }), risk: "safe",
  execute: async (input) => { calls.push(input); return { ok: true, host: input.host }; } });
const sendMailCalls: unknown[] = [];
const sendMail = defineTool({ name: "send_mail", description: "send", input: z.object({ to: z.string() }), risk: "requires_approval",
  execute: async (input) => { sendMailCalls.push(input); return { sent: true }; } });

const agent: AgentDefinition = { key: "test-agent", name: "Test", description: "", trigger: { kind: "manual" }, systemPrompt: "You test.", tools: [ping, sendMail], maxTurns: 3 };

describe("runAgent", () => {
  beforeEach(() => {
    calls.length = 0;
    sendMailCalls.length = 0;
  });

  it("executes a safe tool, returns the result to the model, and completes with the final text", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_1", "ping", { host: "a.test" })], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
        { content: [text("a.test is up")], stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 4 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: { host: "a.test" }, llm, policy: "safe", logger: console });
      expect(result.status).toBe("completed");
      expect(result.summary).toBe("a.test is up");
      expect(calls).toEqual([{ host: "a.test" }]);
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId)).orderBy(schema.agentSteps.seq);
      expect(steps.map((s) => s.kind)).toEqual(["llm", "tool_call", "tool_result", "llm"]);
      const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, result.runId));
      expect(run!.tokensIn).toBe(30);
      // second request carries the tool result back to the model
      const second = llm.requests[1]!;
      const last = second.messages[second.messages.length - 1]!;
      expect(last.role).toBe("user");
    });
  });

  it("parks the run as awaiting_approval when a requires_approval tool is called", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_2", "send_mail", { to: "x@y.test" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
      expect(result.status).toBe("awaiting_approval");
      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, result.runId));
      expect(approval!.status).toBe("pending");
      expect(approval!.payload).toMatchObject({ toolName: "send_mail", input: { to: "x@y.test" } });
      expect(sendMailCalls).toEqual([]);
    });
  });

  it("parks a batch and preserves already-completed results plus the awaiting tool use id", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const llm = new FakeLlmClient([
        {
          content: [toolUse("tu_6", "ping", { host: "a.test" }), toolUse("tu_7", "send_mail", { to: "x@y.test" })],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
      expect(result.status).toBe("awaiting_approval");
      expect(calls).toContainEqual({ host: "a.test" });
      const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, result.runId));
      const pending = (
        run!.metadata as {
          pending: { completedResults: Array<{ tool_use_id: string; content: string }>; awaitingToolUseId: string; remainingToolUseIds: string[] };
        }
      ).pending;
      expect(pending.awaitingToolUseId).toBe("tu_7");
      expect(pending.remainingToolUseIds).toEqual([]);
      expect(pending.completedResults).toHaveLength(1);
      expect(pending.completedResults[0]).toMatchObject({ tool_use_id: "tu_6", content: JSON.stringify({ ok: true, host: "a.test" }) });
      expect(sendMailCalls).toEqual([]);
    });
  });

  it("records a tool_call step and returns an error result for an unknown tool, then completes normally", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_8", "does_not_exist", { any: true })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [text("done")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
      expect(result.status).toBe("completed");
      expect(result.summary).toBe("done");
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId)).orderBy(schema.agentSteps.seq);
      expect(steps.map((s) => s.kind)).toEqual(["llm", "tool_call", "llm"]);
      const toolCallStep = steps.find((s) => s.kind === "tool_call")!;
      expect(toolCallStep.toolName).toBe("does_not_exist");
      expect(toolCallStep.output).toMatchObject({ error: "unknown tool" });
      const second = llm.requests[1]!;
      const last = second.messages[second.messages.length - 1]! as { role: string; content: Array<{ tool_use_id: string; is_error?: boolean }> };
      expect(last.role).toBe("user");
      expect(last.content[0]).toMatchObject({ tool_use_id: "tu_8", is_error: true });
    });
  });

  it("fails the run when the tool input is invalid and the model never finishes", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const llm = new FakeLlmClient([
        { content: [toolUse("tu_3", "ping", { nope: 1 })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("tu_4", "ping", { nope: 1 })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        { content: [toolUse("tu_5", "ping", { nope: 1 })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/maxTurns/);
    });
  });

  it("records a refusal as a failed run with error \"refusal\" and executes no tool", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      const llm = new FakeLlmClient([
        { content: [text("I cannot help with that.")], stopReason: "refusal", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const result = await runAgent(agent, { db, organisationId: org!.id, trigger: "manual", payload: {}, llm, policy: "safe", logger: console });
      expect(result.status).toBe("failed");
      const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, result.runId));
      expect(run!.status).toBe("failed");
      expect(run!.error).toBe("refusal");
      expect(calls).toEqual([]);
      expect(sendMailCalls).toEqual([]);
      const steps = await db.select().from(schema.agentSteps).where(eq(schema.agentSteps.runId, result.runId)).orderBy(schema.agentSteps.seq);
      expect(steps.map((s) => s.kind)).toEqual(["llm"]);
    });
  });
});
