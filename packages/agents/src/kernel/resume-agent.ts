import type Anthropic from "@anthropic-ai/sdk";
import { notifyOwner } from "@launchos/core";
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

/** What `RunRecorder.reopen` stamps on the run when it claims it. */
const ResumeClaim = z.object({ approvalId: z.string().min(1), claimedAt: z.string().min(1) });

/**
 * How long a claimed-but-unfinished run is given before another delivery may
 * call it stranded. Anything shorter risks killing a resume that is simply
 * taking its time.
 */
const STRANDED_AFTER_MS = 5 * 60_000;

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
 * Finishes a run that an *abandoned* earlier attempt left `running`, as
 * `failed`, and tells the owner. Three predicates have to hold, because failing
 * a run that is still working is worse than leaving one to time out:
 *
 * - the run is `running` — a run in `awaiting_approval` is legitimately parked
 *   for some other approval and must never be touched by a stale delivery;
 * - `metadata.resume.approvalId` is *this* approval, so a delivery for one
 *   approval cannot kill a run another approval is driving;
 * - the claim is older than `STRANDED_AFTER_MS`, so a live resume — which
 *   stamped `claimedAt` when it reopened the run — is never eligible.
 *
 * Anything else is logged and left alone; the caller then rethrows and pg-boss
 * retries, which is the right answer while another delivery may still finish.
 * Returns whether it claimed.
 */
async function failStrandedRun(opts: ResumeAgentOptions, error: string): Promise<boolean> {
  const now = (opts.now ?? (() => new Date()))();
  const [run] = await opts.db
    .select({ status: schema.agentRuns.status, metadata: schema.agentRuns.metadata })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.id, opts.runId),
        eq(schema.agentRuns.organisationId, opts.organisationId),
        isNull(schema.agentRuns.deletedAt),
      ),
    );
  if (!run || run.status !== "running") return false;

  const claim = ResumeClaim.safeParse((run.metadata as { resume?: unknown } | null)?.resume);
  if (!claim.success || claim.data.approvalId !== opts.approvalId) {
    opts.logger.warn("left a running run alone: it was not claimed by this approval", {
      runId: opts.runId,
      approvalId: opts.approvalId,
      claimedFor: claim.success ? claim.data.approvalId : null,
    });
    return false;
  }
  const claimedAt = Date.parse(claim.data.claimedAt);
  if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < STRANDED_AFTER_MS) {
    opts.logger.warn("left a running run alone: its claim is too recent to be abandoned", {
      runId: opts.runId,
      approvalId: opts.approvalId,
      claimedAt: claim.data.claimedAt,
    });
    return false;
  }

  const [failed] = await opts.db
    .update(schema.agentRuns)
    .set({ status: "failed", summary: "Resume failed", error, finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentRuns.id, opts.runId),
        eq(schema.agentRuns.organisationId, opts.organisationId),
        eq(schema.agentRuns.status, "running"),
        isNull(schema.agentRuns.deletedAt),
      ),
    )
    .returning({ agentKey: schema.agentRuns.agentKey });
  if (!failed) return false;
  // An approved outward action just vanished. Nothing else surfaces that, so
  // the person who approved it hears about it here.
  await notifyOwner(opts.db, opts.organisationId, {
    kind: "agent.resume_failed",
    title: `${failed.agentKey} could not finish an approved action`,
    body: error,
    link: `/agents/runs/${opts.runId}`,
  }).catch((err) => opts.logger.error("resume failure notification failed", { runId: opts.runId, err: String(err) }));
  return true;
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
 * Everything from `loadParked` onwards sits in one try/catch, because the run
 * flips to `running` in the middle of it: a throw past that point (a lost claim
 * after a killed retry, a database error mid-resume) would otherwise leave the
 * run `running` for ever, with an approved send neither done nor visible. A run
 * this approval claimed and then abandoned is finished `failed` and the owner is
 * told; anything else — a spent approval, a mismatched tool_use, another
 * organisation's run, a resume another delivery is still driving — is thrown to
 * the caller with the run left exactly as it was.
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
    if (!(await failStrandedRun(opts, message))) throw err;
    return { runId: opts.runId, status: "failed", summary: message };
  }
}
