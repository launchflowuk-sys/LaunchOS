import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { LlmClient } from "./llm.js";
import { buildContext, runLoop, type ToolResultBlock } from "./run-loop.js";
import { RunRecorder } from "./run-recorder.js";
import { findTool } from "./tool-registry.js";
import type { AgentContext, AgentDefinition, AgentPolicy, AgentRunResult, Logger, ToolDefinition } from "./types.js";

export const PendingState = z.object({
  messages: z.array(z.unknown()),
  completedResults: z.array(z.unknown()).default([]),
  awaitingToolUseId: z.string().min(1),
  remainingToolUseIds: z.array(z.string()).default([]),
});

const ApprovalPayload = z.object({ toolName: z.string().min(1), input: z.unknown() });

export type ApprovalDecision = "approved" | "rejected";

export interface ResumeAgentOptions {
  db: Db;
  organisationId: string;
  runId: string;
  approvalId: string;
  decision: ApprovalDecision;
  note?: string;
  llm: LlmClient;
  policy: AgentPolicy;
  logger: Logger;
  now?: () => Date;
}

interface LoadedApproval {
  id: string;
  status: string;
  toolName: string;
  input: unknown;
}

/**
 * Loads the parked run's `metadata.pending` and the approval that parked it,
 * both scoped to the organisation. Anything inconsistent throws rather than
 * guessing: a resume that half-works would send outward traffic nobody approved.
 */
async function loadParked(
  opts: ResumeAgentOptions,
): Promise<{ pending: z.infer<typeof PendingState>; approval: LoadedApproval }> {
  const [run] = await opts.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, opts.runId), eq(schema.agentRuns.organisationId, opts.organisationId)));
  if (!run) throw new Error(`agent run ${opts.runId} not found in organisation`);
  const pending = PendingState.parse((run.metadata as { pending?: unknown }).pending);

  const [approval] = await opts.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.id, opts.approvalId),
        eq(schema.approvals.organisationId, opts.organisationId),
        eq(schema.approvals.runId, opts.runId),
      ),
    );
  if (!approval) throw new Error(`approval ${opts.approvalId} does not belong to run ${opts.runId}`);
  if (approval.status !== "pending" && approval.status !== opts.decision) {
    throw new Error(`approval ${opts.approvalId} is ${approval.status}, expected pending or ${opts.decision}`);
  }
  const payload = ApprovalPayload.parse(approval.payload);
  return { pending, approval: { id: approval.id, status: approval.status, ...payload } };
}

/** Records the human's verdict when the caller has not already stamped the row. */
async function recordDecision(opts: ResumeAgentOptions, approval: LoadedApproval): Promise<void> {
  if (approval.status !== "pending") return;
  await opts.db
    .update(schema.approvals)
    .set({
      status: opts.decision,
      decidedAt: (opts.now ?? (() => new Date()))(),
      decisionNote: opts.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.approvals.id, approval.id));
}

async function executeApprovedTool(
  tool: ToolDefinition,
  rawInput: unknown,
  toolUseId: string,
  ctx: AgentContext,
  recorder: RunRecorder,
): Promise<ToolResultBlock> {
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    await recorder.step("tool_call", { toolName: tool.name, input: rawInput, output: { error: parsed.error.message } });
    return { type: "tool_result", tool_use_id: toolUseId, content: `Invalid input: ${parsed.error.message}`, is_error: true };
  }
  await recorder.step("tool_call", { toolName: tool.name, input: parsed.data });
  try {
    const output = await tool.execute(parsed.data, ctx);
    await recorder.step("tool_result", { toolName: tool.name, output });
    return { type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify(output) };
  } catch (err) {
    // A failing approved tool must not lose the run: hand the model the error
    // and let it decide what to do next.
    const message = err instanceof Error ? err.message : String(err);
    await recorder.step("tool_result", { toolName: tool.name, output: { error: message } });
    return { type: "tool_result", tool_use_id: toolUseId, content: `Tool failed: ${message}`, is_error: true };
  }
}

/** The decided tool's result, followed by the batch's untouched tool uses. */
async function buildResumeResults(
  def: AgentDefinition,
  opts: ResumeAgentOptions,
  pending: z.infer<typeof PendingState>,
  approval: LoadedApproval,
  tool: ToolDefinition | undefined,
  ctx: AgentContext,
  recorder: RunRecorder,
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [...(pending.completedResults as ToolResultBlock[])];
  if (opts.decision === "approved") {
    if (!tool) throw new Error(`approved tool ${approval.toolName} is not registered on agent ${def.key}`);
    results.push(await executeApprovedTool(tool, approval.input, pending.awaitingToolUseId, ctx, recorder));
  } else {
    const note = opts.note?.trim() ?? "";
    await recorder.step("note", { toolName: approval.toolName, input: approval.input, output: { rejected: true, note } });
    results.push({
      type: "tool_result",
      tool_use_id: pending.awaitingToolUseId,
      content: `rejected by human: ${note.length > 0 ? note : "no reason given"}`,
      is_error: true,
    });
  }
  for (const id of pending.remainingToolUseIds) {
    results.push({ type: "tool_result", tool_use_id: id, content: "skipped pending approval", is_error: true });
  }
  return results;
}

/**
 * Continues a run parked by the policy gate. The human already decided, so the
 * awaiting tool executes without consulting the gate again; every later turn
 * goes through the gate as normal.
 */
export async function resumeAgent(def: AgentDefinition, opts: ResumeAgentOptions): Promise<AgentRunResult> {
  const { pending, approval } = await loadParked(opts);
  // Resolve the tool before reopening: an unregistered tool must leave the run
  // parked and resumable, not stranded in `running` with nobody driving it.
  const tool = findTool(def.tools, approval.toolName);
  if (opts.decision === "approved" && !tool) {
    throw new Error(`approved tool ${approval.toolName} is not registered on agent ${def.key}`);
  }

  // reopen() is what enforces status === "awaiting_approval".
  const recorder = await RunRecorder.reopen(opts.db, opts.organisationId, opts.runId);
  await recordDecision(opts, approval);
  const ctx = buildContext(opts.db, opts.organisationId, opts.runId, opts.logger, opts.now);

  const results = await buildResumeResults(def, opts, pending, approval, tool, ctx, recorder);
  const messages = [
    ...(pending.messages as Anthropic.Beta.BetaMessageParam[]),
    { role: "user" as const, content: results },
  ];
  return runLoop(def, ctx, recorder, opts.llm, opts.policy, messages);
}
