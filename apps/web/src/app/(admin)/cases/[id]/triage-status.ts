import { schema } from "@launchos/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

/** A run in one of these states may still park an approval for this case. */
const IN_FLIGHT = ["running", "awaiting_approval"] as const;

/**
 * True when Support Triage is already working this case. Shared by the "Run
 * triage now" button (which disables itself) and the action behind it (which
 * refuses), so a direct POST is bounded by the same rule as the UI.
 *
 * The run's ticket comes from `agent_runs.input`, which is how both the
 * event-driven and the manual payloads carry it.
 */
export async function hasTriageInFlight(organisationId: string, ticketId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.organisationId, organisationId),
        eq(schema.agentRuns.agentKey, "support-triage"),
        inArray(schema.agentRuns.status, [...IN_FLIGHT]),
        sql`${schema.agentRuns.input}->>'ticketId' = ${ticketId}`,
      ),
    )
    .limit(1);
  return !!row;
}
