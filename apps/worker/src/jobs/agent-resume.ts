import { schema } from "@launchos/db";
import { resumeAgent } from "@launchos/agents";
import { and, eq } from "drizzle-orm";
import { resolvePolicy, type AgentRunDeps } from "./agent-run.js";

export interface AgentResumeJob {
  organisationId: string;
  runId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  note?: string;
  decidedByUserId?: string;
}

/**
 * Deliberately does not check `agent_enablement.enabled`: a human has already
 * approved or rejected this specific tool call, and a run parked mid-flight
 * must be closed out even if the agent was switched off in the meantime. The
 * per-organisation *policy* still applies to every later turn.
 */
export async function handleAgentResume(deps: AgentRunDeps, job: AgentResumeJob) {
  const [run] = await deps.db
    .select({ agentKey: schema.agentRuns.agentKey, status: schema.agentRuns.status })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, job.runId), eq(schema.agentRuns.organisationId, job.organisationId)));
  if (!run) throw new Error(`agent run ${job.runId} not found`);

  // Only a parked run can be resumed. pg-boss retries a job that died, and a
  // finished run would fail identically on every one of those retries, so this
  // is an idempotent no-op rather than a throw: a retry storm against a run
  // that is already done buries the real failures.
  //
  // A `running` run is deliberately NOT skipped. That is the stranded case — an
  // earlier delivery claimed it and was killed — and `resumeAgent` is what ends
  // it: it fails the run with the lost-claim error and notifies the owner, so
  // the next retry sees `failed` and stops here instead.
  if (run.status === "completed" || run.status === "failed") {
    deps.logger.info("agent.resume ignored: run already finished", {
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
    decision: job.decision,
    // `exactOptionalPropertyTypes` treats an explicit `undefined` value as
    // different from an absent key, so only set these when the job carried them.
    ...(job.note !== undefined && { note: job.note }),
    ...(job.decidedByUserId !== undefined && { decidedByUserId: job.decidedByUserId }),
    llm: deps.llm,
    policy: resolvePolicy(deps.policy, enablement?.config),
    logger: deps.logger,
  });
}
