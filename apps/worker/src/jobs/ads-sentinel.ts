import { AD_SENTINEL_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import type { AgentRunJob } from "./agent-run.js";

/**
 * Fans the daily 07:00 cron out into one `agent.run` per organisation that has
 * the Sentinel enabled. A single cron payload cannot carry every organisation,
 * so the schedule wakes this queue and this queue does the fan-out.
 */
export async function buildSentinelJobs(db: Db, now: Date): Promise<AgentRunJob[]> {
  const rows = await db.select({ organisationId: schema.agentEnablement.organisationId })
    .from(schema.agentEnablement)
    .where(and(
      eq(schema.agentEnablement.agentKey, AD_SENTINEL_KEY),
      eq(schema.agentEnablement.enabled, true),
    ));
  return rows.map((row) => ({
    agentKey: AD_SENTINEL_KEY,
    organisationId: row.organisationId,
    trigger: "cron" as const,
    payload: { now: now.toISOString() },
  }));
}
