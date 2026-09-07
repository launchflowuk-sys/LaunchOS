import { hasAgentRunInFlight, listAgentEnablement, recordAudit } from "@launchos/core";
import { getDb } from "@/lib/db";
import { agentCatalog } from "@/lib/agent-catalog";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { isRunnableAgent, payloadFor, RUNNABLE_AGENTS, singletonKeyFor } from "@/lib/api/actions";
import { apiAccepted, apiError } from "@/lib/api/respond";
import { sendJob } from "@/lib/queue";

export const dynamic = "force-dynamic";

/**
 * Start an agent. The only thing this API can make happen.
 *
 * It puts a job on the same `agent.run` queue the cron dispatchers use and
 * stops there. The worker re-checks `agent_enablement`, resolves the stricter
 * of the environment and organisation policy, and parks every approval-gated
 * tool for a human — none of which this route can influence, because it is not
 * on that path. That is the whole point of spec point 5: Mr. Green acts through
 * the OS, so everything it does is already audited, tenant-scoped and
 * reversible without anything new having to be trusted.
 *
 * Answers 202, not 200: the run has been accepted, not performed. Reading what
 * came of it is `/api/v1/brief` a minute later, or the admin's Agent runs page.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/v1/actions/[key]">): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  if (!callerMay(auth.caller, "settings")) return forbidden("settings");

  const { key } = await params;

  if (!isRunnableAgent(key)) {
    // Two different noes, and the difference matters to whoever is reading:
    // an agent that does not exist is a typo, while one that exists but is
    // event-driven is a thing that will happen on its own.
    const known = agentCatalog().some((agent) => agent.key === key);
    return known
      ? apiError(
          "bad_request",
          `"${key}" is driven by an event about a specific thing (a case, a lead, a project) and cannot be started without one. It runs on its own when that happens.`,
        )
      : apiError("not_found", `no agent called "${key}". GET /api/v1/capabilities lists them.`);
  }

  const db = getDb();
  const enablement = await listAgentEnablement(db, auth.caller.organisationId);
  if (enablement[key] !== true) {
    // The worker would accept this job and silently skip it, so the caller
    // would be told "queued" and see nothing happen — the exact shape of
    // failure that is worse than an error. Refuse it here, with the reason.
    return apiError(
      "bad_request",
      enablement[key] === false
        ? `${RUNNABLE_AGENTS[key].label} is switched off for this organisation. Turn it on in Settings → Agents.`
        : `${RUNNABLE_AGENTS[key].label} has never been configured for this organisation. Turn it on in Settings → Agents.`,
    );
  }

  if (await hasAgentRunInFlight(db, auth.caller.organisationId, key)) {
    // Every run is a real, billed Claude call.
    return apiError("conflict", `${RUNNABLE_AGENTS[key].label} is already running. Wait for it to finish.`);
  }

  const now = new Date();
  const jobId = await sendJob(
    "agent.run",
    { agentKey: key, organisationId: auth.caller.organisationId, trigger: "manual", payload: payloadFor(key, now) },
    { singletonKey: singletonKeyFor(key, auth.caller.organisationId, now) },
  );

  // pg-boss refused it as a duplicate of one queued moments ago. Saying
  // "accepted" here would be the lie this whole route is shaped to avoid: the
  // caller would wait for a second run that is never going to exist.
  if (jobId === null) {
    return apiError("conflict", `An identical request for ${RUNNABLE_AGENTS[key].label} was queued moments ago and is still waiting.`);
  }

  // Audited as the token, not as a person: `actorKind: "agent"` with the
  // token's name, so the log says which key started this rather than implying
  // Shoji pressed a button.
  await recordAudit(db, auth.caller.organisationId, {
    actorKind: "agent",
    actorId: auth.caller.tokenId,
    action: "agent.run_requested",
    targetType: "agent",
    targetId: key,
    after: { agentKey: key, via: "api", token: auth.caller.name, jobId },
  });

  return apiAccepted(
    { accepted: true, agentKey: key, label: RUNNABLE_AGENTS[key].label, jobId, queuedAt: now.toISOString() },
    { organisationId: auth.caller.organisationId, generatedAt: now.toISOString() },
  );
}
