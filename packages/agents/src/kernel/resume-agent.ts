import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
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

// `toolUseId` is required: it is what binds an approval to the exact tool_use
// block a human looked at. Without it a stale approval could be replayed
// against a later parked call and execute a tool nobody approved.
const ApprovalPayload = z.object({
  toolName: z.string().min(1),
  input: z.unknown(),
  toolUseId: z.string().min(1),
});

export type ApprovalDecision = "approved" | "rejected";

export interface ResumeAgentOptions {
  db: Db;
  organisationId: string;
  runId: string;
  approvalId: string;
  /**
   * Cross-check only. The decision, the note and the approver are read from the
   * `approvals` row, which `decideApproval` stamped before this job was ever
   * enqueued; a payload that disagrees is logged and ignored rather than
   * trusted, because a job body is not a record of what a human decided.
   */
  decision?: ApprovalDecision;
  note?: string;
  llm: LlmClient;
  policy: AgentPolicy;
  logger: Logger;
  now?: () => Date;
}

type Pending = z.infer<typeof PendingState>;

interface LoadedApproval {
  id: string;
  toolName: string;
  input: unknown;
  toolUseId: string;
  /** Every field below comes from the approvals row, never from the job. */
  decision: ApprovalDecision;
  decidedBy: string | undefined;
  note: string;
}

function parsePending(runId: string, metadata: unknown): Pending {
  const parsed = PendingState.safeParse((metadata as { pending?: unknown } | null)?.pending);
  if (!parsed.success) throw new Error(`agent run ${runId} has no resumable pending state`);
  return parsed.data;
}

/**
 * Loads the parked run's `metadata.pending` and the approval that parked it,
 * both scoped to the organisation. Anything inconsistent throws rather than
 * guessing: a resume that half-works would send outward traffic nobody approved.
 *
 * The approval must already carry a decision. `decideApproval` is the single
 * writer of `status`, `decided_by`, `decided_at` and `decision_note`, and it
 * writes them before the `agent.resume` job is enqueued, so a still-`pending`
 * row means nobody decided and there is nothing to resume. What stops a *spent*
 * decision being replayed is the run: `metadata.pending` is cleared the moment
 * the run finishes or re-parks, and `payload.toolUseId` must still match the
 * tool_use the run is waiting on.
 */
async function loadParked(opts: ResumeAgentOptions): Promise<{ pending: Pending; approval: LoadedApproval }> {
  const [run] = await opts.db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.id, opts.runId),
        eq(schema.agentRuns.organisationId, opts.organisationId),
        isNull(schema.agentRuns.deletedAt),
      ),
    );
  if (!run) throw new Error(`agent run ${opts.runId} not found in organisation`);
  const pending = parsePending(opts.runId, run.metadata);

  const [approval] = await opts.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.id, opts.approvalId),
        eq(schema.approvals.organisationId, opts.organisationId),
        eq(schema.approvals.runId, opts.runId),
        isNull(schema.approvals.deletedAt),
      ),
    );
  if (!approval) throw new Error(`approval ${opts.approvalId} does not belong to run ${opts.runId}`);
  if (approval.status === "pending") {
    throw new Error(`approval ${opts.approvalId} is pending, expected a recorded decision`);
  }
  const payload = ApprovalPayload.parse(approval.payload);
  if (payload.toolUseId !== pending.awaitingToolUseId) {
    throw new Error(
      `approval ${opts.approvalId} approves tool_use ${payload.toolUseId}, but run ${opts.runId} is awaiting ${pending.awaitingToolUseId}`,
    );
  }
  // A job carrying a different verdict than the row is a bug in the enqueue
  // path, not a second opinion. Say so loudly; act on the row.
  if (opts.decision && opts.decision !== approval.status) {
    opts.logger.warn("agent.resume payload disagrees with the approvals row", {
      runId: opts.runId,
      approvalId: opts.approvalId,
      payloadDecision: opts.decision,
      rowDecision: approval.status,
    });
  }
  return {
    pending,
    approval: {
      id: approval.id,
      ...payload,
      decision: approval.status,
      decidedBy: approval.decidedBy ?? undefined,
      note: approval.decisionNote ?? opts.note ?? "",
    },
  };
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
  pending: Pending,
  approval: LoadedApproval,
  tool: ToolDefinition | undefined,
  ctx: AgentContext,
  recorder: RunRecorder,
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [...(pending.completedResults as ToolResultBlock[])];
  if (approval.decision === "approved") {
    if (!tool) throw new Error(`approved tool ${approval.toolName} is not registered on agent ${def.key}`);
    results.push(await executeApprovedTool(tool, approval.input, approval.toolUseId, ctx, recorder));
  } else {
    const note = approval.note.trim();
    await recorder.step("note", { toolName: approval.toolName, input: approval.input, output: { rejected: true, note } });
    results.push({
      type: "tool_result",
      tool_use_id: approval.toolUseId,
      content: `rejected by human: ${note.length > 0 ? note : "no reason given"}`,
      is_error: true,
    });
  }
  if (pending.remainingToolUseIds.length > 0) {
    // The rest of the batch never ran. Say so in the trace, not just to the model.
    await recorder.step("note", {
      output: { skippedToolUseIds: pending.remainingToolUseIds, reason: "skipped pending approval" },
    });
    for (const id of pending.remainingToolUseIds) {
      results.push({ type: "tool_result", tool_use_id: id, content: "skipped pending approval", is_error: true });
    }
  }
  return results;
}

async function resumeMessages(
  def: AgentDefinition,
  pending: Pending,
  approval: LoadedApproval,
  tool: ToolDefinition | undefined,
  ctx: AgentContext,
  recorder: RunRecorder,
): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const results = await buildResumeResults(def, pending, approval, tool, ctx, recorder);
  return [...(pending.messages as Anthropic.Beta.BetaMessageParam[]), { role: "user" as const, content: results }];
}

/**
 * Continues a run parked by the policy gate. The human already decided, so the
 * awaiting tool executes without consulting the gate again; every later turn
 * goes through the gate as normal.
 *
 * The decision, the note and the approver all come from the `approvals` row
 * that `decideApproval` stamped: `ctx.approvedByUserId` is `approvals
 * .decided_by`, so a tool that records who acted names the human the database
 * says released it, and a job with a missing or wrong field cannot silently
 * re-attribute an outward action to the agent.
 *
 * Everything from `loadParked` onwards sits in one try/catch so the failure is
 * logged against the run before it leaves, and then it is **rethrown**: the run
 * is left exactly as it was and pg-boss retries. Deciding that a `running` run
 * is dead is not this function's job and cannot be — from in here, "an earlier
 * delivery died" and "another delivery is working right now" look identical, and
 * the timestamp test this used to apply failed working resumes. That call
 * belongs to `agent-runs.stuck-sweep`, which asks the only question that
 * distinguishes them: has the run recorded a step lately? A `running` run is
 * therefore closed out there and nowhere else.
 */
export async function resumeAgent(def: AgentDefinition, opts: ResumeAgentOptions): Promise<AgentRunResult> {
  try {
    const { pending, approval } = await loadParked(opts);
    // Resolve the tool before reopening: an unregistered tool must leave the run
    // parked and resumable, not stranded in `running` with nobody driving it.
    const tool = findTool(def.tools, approval.toolName);
    if (approval.decision === "approved" && !tool) {
      throw new Error(`approved tool ${approval.toolName} is not registered on agent ${def.key}`);
    }

    const recorder = await RunRecorder.reopen(opts.db, opts.organisationId, opts.runId, {
      approvalId: approval.id,
      claimedAt: (opts.now ?? (() => new Date()))(),
    });
    const ctx = buildContext(opts.db, opts.organisationId, opts.runId, opts.logger, opts.now, approval.decidedBy);
    const messages = await resumeMessages(def, pending, approval, tool, ctx, recorder);
    return runLoop(def, ctx, recorder, opts.llm, opts.policy, messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.logger.error("agent resume failed", { runId: opts.runId, err: message });
    throw err;
  }
}
