import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { FakeLlmClient, defineTool, text, toolUse, type AgentDefinition } from "@launchos/agents";
import { handleAgentRun } from "./agent-run.js";

const ping = defineTool({
  name: "ping",
  description: "ping",
  input: z.object({ host: z.string() }),
  risk: "safe",
  execute: async (input) => ({ ok: true, host: input.host }),
});

const agent: AgentDefinition = {
  key: "test-agent",
  name: "Test",
  description: "",
  trigger: { kind: "manual" },
  systemPrompt: "You test.",
  tools: [ping],
  maxTurns: 3,
};

const registry = { "test-agent": agent };
const job = { agentKey: "test-agent", organisationId: "", trigger: "manual" as const, payload: {} };

function scriptedLlm() {
  return new FakeLlmClient([
    { content: [toolUse("tu_1", "ping", { host: "a.test" })], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [text("done")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
}

const quietLogger = { ...console, info: () => {} } as Console;

describe("handleAgentRun", () => {
  it("skips a disabled agent without starting a run", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      await db.insert(schema.agentEnablement).values({ organisationId: org!.id, agentKey: "test-agent", enabled: false });

      const result = await handleAgentRun(
        { db, registry, llm: scriptedLlm(), policy: "safe", logger: quietLogger },
        { ...job, organisationId: org!.id },
      );

      expect(result).toBeUndefined();
      const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.organisationId, org!.id));
      expect(runs).toHaveLength(0);
    });
  });

  it("treats an unparseable config.policy as unset: runs safely when the env policy is safe", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      await db.insert(schema.agentEnablement).values({
        organisationId: org!.id,
        agentKey: "test-agent",
        enabled: true,
        config: { policy: "yolo" },
      });

      const result = await handleAgentRun(
        { db, registry, llm: scriptedLlm(), policy: "safe", logger: quietLogger },
        { ...job, organisationId: org!.id },
      );

      expect(result?.status).toBe("completed");
    });
  });

  it("never falls open: an unparseable config.policy keeps an approval_all env policy", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      await db.insert(schema.agentEnablement).values({
        organisationId: org!.id,
        agentKey: "test-agent",
        enabled: true,
        config: { policy: "yolo" },
      });

      const result = await handleAgentRun(
        { db, registry, llm: scriptedLlm(), policy: "approval_all", logger: quietLogger },
        { ...job, organisationId: org!.id },
      );

      expect(result?.status).toBe("awaiting_approval");
      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, result!.runId));
      expect(approval!.payload).toMatchObject({ toolName: "ping" });
    });
  });

  it("takes the stricter policy when the database asks for approval_all and the env is safe", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning();
      await db.insert(schema.agentEnablement).values({
        organisationId: org!.id,
        agentKey: "test-agent",
        enabled: true,
        config: { policy: "approval_all" },
      });

      const result = await handleAgentRun(
        { db, registry, llm: scriptedLlm(), policy: "safe", logger: quietLogger },
        { ...job, organisationId: org!.id },
      );

      expect(result?.status).toBe("awaiting_approval");
    });
  });
});
