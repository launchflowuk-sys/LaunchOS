import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { LlmClient } from "./llm.js";
import { decide } from "./policy-gate.js";
import type { RunRecorder } from "./run-recorder.js";
import { findTool, toClaudeTools } from "./tool-registry.js";
import type { AgentContext, AgentDefinition, AgentPolicy, AgentRunResult, Logger, ToolDefinition } from "./types.js";

export type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

export interface ToolUseOutcome {
  parked: boolean;
  summary: string;
  results: ToolResultBlock[];
  completedResults?: ToolResultBlock[];
  awaitingToolUseId?: string;
  remainingToolUseIds?: string[];
}

export function buildContext(db: Db, organisationId: string, runId: string, logger: Logger, now?: () => Date): AgentContext {
  return { organisationId, runId, db, logger, now: now ?? (() => new Date()) };
}

/**
 * The shared LLM <-> tool loop. `runAgent` enters it with the payload as the
 * first user message; `resumeAgent` enters it with the parked message list plus
 * the approval's tool results. Neither owns the loop, so the two paths can
 * never drift.
 */
export async function runLoop(
  def: AgentDefinition,
  ctx: AgentContext,
  recorder: RunRecorder,
  llm: LlmClient,
  policy: AgentPolicy,
  initialMessages: Anthropic.Beta.BetaMessageParam[],
): Promise<AgentRunResult> {
  const tools = toClaudeTools(def.tools);
  const model = def.model ?? process.env.AGENT_MODEL ?? "claude-opus-5";
  let messages = initialMessages;

  try {
    for (let turn = 0; turn < def.maxTurns; turn++) {
      const res = await llm.complete({ model, system: def.systemPrompt, messages, tools });
      await recorder.step("llm", { output: res.content, tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens });
      await recorder.addTokens(res.usage.inputTokens, res.usage.outputTokens);
      messages = [...messages, { role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] }];

      if (res.stopReason === "refusal") {
        await recorder.finish("failed", "Model refused the request", "refusal");
        return { runId: recorder.runId, status: "failed", summary: "Model refused the request" };
      }
      if (res.stopReason !== "tool_use") {
        const summary = extractText(res.content);
        await recorder.finish("completed", summary);
        return { runId: recorder.runId, status: "completed", summary };
      }

      const uses = res.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
      const outcome = await handleToolUses(def, uses, ctx, recorder, policy);
      if (outcome.parked) {
        await recorder.finish("awaiting_approval", outcome.summary, undefined, buildPendingMetadata(messages, outcome));
        return { runId: recorder.runId, status: "awaiting_approval", summary: outcome.summary };
      }
      messages = [...messages, { role: "user", content: outcome.results }];
    }
    await recorder.finish("failed", `Stopped after maxTurns=${def.maxTurns}`, "max_turns");
    return { runId: recorder.runId, status: "failed", summary: `Stopped after maxTurns=${def.maxTurns}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error("agent run failed", { runId: recorder.runId, err: message });
    await recorder.finish("failed", "Run failed", message);
    return { runId: recorder.runId, status: "failed", summary: message };
  }
}

function extractText(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}

function buildPendingMetadata(messages: Anthropic.Beta.BetaMessageParam[], outcome: ToolUseOutcome): Record<string, unknown> {
  return {
    messages,
    completedResults: outcome.completedResults,
    awaitingToolUseId: outcome.awaitingToolUseId,
    remainingToolUseIds: outcome.remainingToolUseIds,
  };
}

async function handleToolUses(
  def: AgentDefinition,
  uses: Anthropic.Beta.BetaToolUseBlock[],
  ctx: AgentContext,
  recorder: RunRecorder,
  policy: AgentPolicy,
): Promise<ToolUseOutcome> {
  const results: ToolResultBlock[] = [];
  for (let i = 0; i < uses.length; i++) {
    const use = uses[i]!;
    const tool = findTool(def.tools, use.name);
    if (!tool) {
      await recorder.step("tool_call", { toolName: use.name, input: use.input, output: { error: "unknown tool" } });
      results.push({ type: "tool_result", tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true });
      continue;
    }
    const parsed = tool.input.safeParse(use.input);
    if (!parsed.success) {
      await recorder.step("tool_call", { toolName: tool.name, input: use.input, output: { error: parsed.error.message } });
      results.push({ type: "tool_result", tool_use_id: use.id, content: `Invalid input: ${parsed.error.message}`, is_error: true });
      continue;
    }
    if (decide(tool, policy) === "queue_approval") {
      await parkForApproval(def, tool, parsed.data, use.id, ctx, recorder);
      return {
        parked: true,
        summary: `Awaiting approval for ${tool.name}`,
        results,
        completedResults: results,
        awaitingToolUseId: use.id,
        remainingToolUseIds: uses.slice(i + 1).map((u) => u.id),
      };
    }
    await recorder.step("tool_call", { toolName: tool.name, input: parsed.data });
    const output = await tool.execute(parsed.data, ctx);
    await recorder.step("tool_result", { toolName: tool.name, output });
    results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) });
  }
  return { parked: false, summary: "", results };
}

async function parkForApproval(
  def: AgentDefinition,
  tool: ToolDefinition,
  input: unknown,
  toolUseId: string,
  ctx: AgentContext,
  recorder: RunRecorder,
): Promise<void> {
  const step = await recorder.step("approval_requested", { toolName: tool.name, input });
  await ctx.db.insert(schema.approvals).values({
    organisationId: ctx.organisationId,
    runId: ctx.runId,
    stepId: step.id,
    kind: "tool_call",
    title: `${def.name} wants to run ${tool.name}`,
    payload: { toolName: tool.name, input, toolUseId, awaitingToolUseId: toolUseId },
  });
}
