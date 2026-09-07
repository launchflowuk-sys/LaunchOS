import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, inArray } from "drizzle-orm";

/** A run in one of these states may still do work, or still park an approval. */
const IN_FLIGHT = ["running", "awaiting_approval"] as const;

/**
 * Whether this agent is already working for this organisation.
 *
 * Every run is a real, billed Claude call. Starting a second one because a
 * caller retried — a flaky connection, an impatient assistant, a cron that
 * fired twice — pays for the same work twice and can queue two drafts of the
 * same outward message for a human to pick between. The admin's "Run triage
 * now" button already refuses on this basis (`hasTriageInFlight`); this is the
 * same rule for an agent that has no subject, where the whole organisation is
 * the subject.
 *
 * Deliberately coarse: one run of an agent at a time per organisation. For a
 * subject-bearing agent that would be too strict — two different cases can be
 * triaged at once — which is why this is not that function.
 */
export async function hasAgentRunInFlight(db: Db, organisationId: string, agentKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.organisationId, organisationId),
        eq(schema.agentRuns.agentKey, agentKey),
        inArray(schema.agentRuns.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);

  return row !== undefined;
}
