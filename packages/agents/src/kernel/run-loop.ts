import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { LlmClient } from "./llm.js";
import { decide } from "./policy-gate.js";
import type { AgentRunStatus, RunRecorder } from "./run-recorder.js";
import { findTool, toClaudeTools } from "./tool-registry.js";
import type {
  AgentContext,
  AgentDefinition,
  AgentPolicy,
  AgentRunResult,
  ApprovalDescription,
  Logger,
  ToolDefinition,
} from "./types.js";

export type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

export interface ToolUseOutcome {
  parked: boolean;
  summary: string;
  results: ToolResultBlock[];
  completedResults?: ToolResultBlock[];
  awaitingToolUseId?: string;
  remainingToolUseIds?: string[];
}

export function buildContext(
  db: Db,
  organisationId: string,
  runId: string,
  logger: Logger,
  now?: () => Date,
  approvedByUserId?: string,
): AgentContext {
  return {
    organisationId,
    runId,
    db,
    logger,
    now: now ?? (() => new Date()),
    // `exactOptionalPropertyTypes`: an explicit undefined is not the same as an
    // absent key, and "nobody approved this" must read as absent.
    ...(approvedByUserId !== undefined && { approvedByUserId }),
  };
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
        return settle(ctx, recorder, "failed", "Model refused the request", "refusal");
      }
      if (res.stopReason !== "tool_use") {
        return settle(ctx, recorder, "completed", extractText(res.content));
      }

      const uses = res.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
      const outcome = await handleToolUses(def, uses, ctx, recorder, policy);
      if (outcome.parked) {
        return settle(ctx, recorder, "awaiting_approval", outcome.summary, undefined, buildPendingMetadata(messages, outcome));
      }
      messages = [...messages, { role: "user", content: outcome.results }];
    }
    return settle(ctx, recorder, "failed", `Stopped after maxTurns=${def.maxTurns}`, "max_turns");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error("agent run failed", { runId: recorder.runId, err: message });
    return settle(ctx, recorder, "failed", message, message);
  }
}

/**
 * Writes the run's outcome and reports it — unless something else already
 * declared this run terminal, in which case the outcome is dropped with a log
 * line rather than written over the top.
 *
 * The only thing that can get there first is the stranded-run sweeper, which
 * fails a run that has gone half an hour with no step and tells the owner the
 * approved action did not finish. A late delivery that then wrote `completed`
 * would contradict the notification the owner already read, so this path stops
 * instead: the row and the notification agree, and the trace shows both.
 */
async function settle(
  ctx: AgentContext,
  recorder: RunRecorder,
  status: AgentRunStatus,
  summary: string,
  error?: string,
  pending?: Record<string, unknown>,
): Promise<AgentRunResult> {
  if (await recorder.finish(status, summary, error, pending)) {
    return { runId: recorder.runId, status, summary };
  }
  ctx.logger.warn("run was already finished by something else; discarding this outcome", {
    runId: recorder.runId,
    discarded: status,
    summary,
  });
  return {
    runId: recorder.runId,
    status: "failed",
    summary: `run ${recorder.runId} was already finished elsewhere; ${status} discarded`,
  };
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

/**
 * A human cannot release what they cannot see. `describeApproval` reads our own
 * rows and turns a bare `{ adReportId }` into "Send the 1–7 September ads report
 * to Grays CabLine", plus the text that will actually leave the building. It is
 * best-effort: a description that throws must not stop the run parking, or a
 * lookup failure would turn an approval gate into an unrecorded silence.
 */
async function describeForApproval(
  tool: ToolDefinition,
  input: unknown,
  ctx: AgentContext,
): Promise<ApprovalDescription | undefined> {
  if (!tool.describeApproval) return undefined;
  try {
    return await tool.describeApproval(input, ctx);
  } catch (err) {
    ctx.logger.warn("approval description failed", {
      tool: tool.name,
      runId: ctx.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function parkForApproval(
  def: AgentDefinition,
  tool: ToolDefinition,
  input: unknown,
  toolUseId: string,
  ctx: AgentContext,
  recorder: RunRecorder,
): Promise<void> {
  const description = await describeForApproval(tool, input, ctx);
  const step = await recorder.step("approval_requested", { toolName: tool.name, input, output: description ?? {} });
  await ctx.db.insert(schema.approvals).values({
    organisationId: ctx.organisationId,
    runId: ctx.runId,
    stepId: step.id,
    kind: "tool_call",
    title: description?.title ?? `${def.name} wants to run ${tool.name}`,
    // `toolUseId` is the binding, and the only one: `resume-agent.ts` compares
    // it against the run's `metadata.pending.awaitingToolUseId`, and
    // `approvals.resume-sweep` joins on exactly these two fields in SQL. The
    // payload used to carry a duplicate `awaitingToolUseId` with the same
    // value, which nothing read — a second name for the same fact is a way for
    // the two to disagree later.
    payload: {
      toolName: tool.name,
      input,
      toolUseId,
      ...(description && { description }),
    },
  });
}
