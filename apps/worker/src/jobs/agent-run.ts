import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { runAgent, type AgentDefinition, type AgentPolicy, type LlmClient } from "@launchos/agents";

export interface AgentRunJob { agentKey: string; organisationId: string; trigger: "cron" | "event" | "manual"; payload: Record<string, unknown>; }
export interface AgentRunDeps { db: Db; registry: Record<string, AgentDefinition>; llm: LlmClient; policy: AgentPolicy; logger: Console; }

export async function handleAgentRun(deps: AgentRunDeps, job: AgentRunJob) {
  const def = deps.registry[job.agentKey];
  if (!def) throw new Error(`unknown agent ${job.agentKey}`);
  const [enablement] = await deps.db.select().from(schema.agentEnablement)
    .where(and(eq(schema.agentEnablement.organisationId, job.organisationId), eq(schema.agentEnablement.agentKey, job.agentKey)));
  if (!enablement?.enabled) { deps.logger.info(`agent ${job.agentKey} disabled for ${job.organisationId}; skipping`); return; }
  const policy = (enablement.config as { policy?: AgentPolicy }).policy ?? deps.policy;
  return runAgent(def, { db: deps.db, organisationId: job.organisationId, trigger: job.trigger, payload: job.payload, llm: deps.llm, policy, logger: deps.logger });
}

/** Builds the guard-dog payload from an incident id. */
export async function incidentPayload(db: Db, organisationId: string, incidentId: string) {
  const [row] = await db.select({ incidentId: schema.incidents.id, siteId: schema.sites.id, clientId: schema.sites.clientId, url: schema.sites.primaryUrl, hostingRef: schema.sites.hostingRef })
    .from(schema.incidents).innerJoin(schema.sites, eq(schema.sites.id, schema.incidents.siteId))
    .where(and(eq(schema.incidents.id, incidentId), eq(schema.incidents.organisationId, organisationId)));
  if (!row) throw new Error(`incident ${incidentId} not found`);
  return { ...row, hostingRef: row.hostingRef ?? "unknown" };
}
