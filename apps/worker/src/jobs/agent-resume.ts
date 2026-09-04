import { schema } from "@launchos/db";
import { resumeAgent } from "@launchos/agents";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolvePolicy, type AgentRunDeps } from "./agent-run.js";

/**
 * The job body, parsed rather than trusted: it crosses a process boundary, so
 * CLAUDE.md's "Zod at every boundary" applies. It deliberately carries no
 * approver and no decision of record — `resumeAgent` reads both from the
 * `approvals` row `decideApproval` stamped, so a malformed or stale payload
 * can never re-attribute an outward action. `decision` and `note` ride along
 * only as a cross-check the kernel logs on a mismatch.
 */
export const AgentResumeJobSchema = z.object({
  organisationId: z.string().uuid(),
  runId: z.string().uuid(),
  approvalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().optional(),
});
export type AgentResumeJob = z.infer<typeof AgentResumeJobSchema>;

/**
 * Deliberately does not check `agent_enablement.enabled`: a human has already
 * approved or rejected this specific tool call, and a run parked mid-flight
 * must be closed out even if the agent was switched off in the meantime. The
 * per-organisation *policy* still applies to every later turn.
 */
export async function handleAgentResume(deps: AgentRunDeps, raw: AgentResumeJob) {
  const job = AgentResumeJobSchema.parse(raw);
  const [run] = await deps.db
    .select({ agentKey: schema.agentRuns.agentKey, status: schema.agentRuns.status })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, job.runId), eq(schema.agentRuns.organisationId, job.organisationId)));
  if (!run) throw new Error(`agent run ${job.runId} not found`);

  // Only a parked run can be resumed. pg-boss retries a job that died, and a
  // run that is finished — or that another delivery is already driving — would
  // fail identically on every one of those retries, so this is an idempotent
  // no-op rather than a throw: a retry storm against a run nothing can do
  // anything about buries the real failures.
  //
  // `running` is included on purpose. From here, "an earlier delivery claimed
  // this run and died" and "another delivery is executing it right now" are the
  // same row, and the kernel used to guess between them on the age of the claim
  // — which failed working resumes that simply took longer than five minutes.
  // The only evidence that separates them is whether the run is still recording
  // steps, and that question is asked by `agent-runs.stuck-sweep`, which is now
  // the single mechanism that closes a stranded run.
  if (run.status === "completed" || run.status === "failed" || run.status === "running") {
    deps.logger.info("agent.resume ignored: the run is not parked", {
      runId: job.runId,
      approvalId: job.approvalId,
      status: run.status,
    });
    return undefined;
  }

  const def = deps.registry[run.agentKey];
  if (!def) throw new Error(`unknown agent ${run.agentKey}`);

  const [enablement] = await deps.db
    .select()
    .from(schema.agentEnablement)
    .where(and(eq(schema.agentEnablement.organisationId, job.organisationId), eq(schema.agentEnablement.agentKey, run.agentKey)));

  return resumeAgent(def, {
    db: deps.db,
    organisationId: job.organisationId,
    runId: job.runId,
    approvalId: job.approvalId,
    // Both are cross-checks only; the kernel takes the decision, the note and
    // the approver from the approvals row.
    decision: job.decision,
    // `exactOptionalPropertyTypes` treats an explicit `undefined` value as
    // different from an absent key, so only set this when the job carried it.
    ...(job.note !== undefined && { note: job.note }),
    llm: deps.llm,
    policy: resolvePolicy(deps.policy, enablement?.config),
    logger: deps.logger,
  });
}
