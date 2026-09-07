/**
 * What Mr. Green may start, and with what.
 *
 * Spec point 5: it acts **through** the OS, not around it. So there is no tool
 * endpoint and no write path of its own — the only thing this API can do is put
 * an `agent.run` job on the same queue the cron dispatchers use. Everything
 * after that is machinery that already exists and is already trusted: the
 * worker checks `agent_enablement`, `resolvePolicy` takes the stricter of the
 * environment and the organisation, and `runAgent` parks every
 * `requires_approval` tool in `approvals` for a human. Nothing here can loosen
 * any of it, because nothing here is on that path.
 *
 * **Why only two agents.** An agent's payload is not free-form: Support Triage
 * wants a ticket, Content Writer a client and a period, Case Study Writer a
 * case study. Accepting those ids from outside means proving each one belongs
 * to the caller's organisation before using it, and the functions that do that
 * proving (`ticketPayload`, `incidentPayload`) live in `apps/worker`, which
 * `apps/web` must not import from. Guessing a payload shape instead would be a
 * tenancy hole dressed as a convenience.
 *
 * So the API starts the two agents whose subject is the whole organisation and
 * whose payload is therefore just the clock. They also happen to be the two
 * Shoji would actually ask for out loud — "what's happening" and "how are the
 * ads doing". The rest stay driven by the events that know their own subject,
 * and say so when asked.
 */

/** Agents that can be started with nothing but the current time. */
export const RUNNABLE_AGENTS = {
  "ops-brief": {
    label: "Ops Brief",
    what: "Writes today's brief from the current numbers.",
  },
  "ad-performance-sentinel": {
    label: "Ad Performance Sentinel",
    what: "Reviews ad accounts and drafts a report. Sending it still needs approval.",
  },
} as const;

export type RunnableAgentKey = keyof typeof RUNNABLE_AGENTS;

export function isRunnableAgent(key: string): key is RunnableAgentKey {
  return Object.hasOwn(RUNNABLE_AGENTS, key);
}

/**
 * The payload the worker's cron dispatchers send for these two, matched
 * exactly. `ops-brief.ts` and `ads-sentinel.ts` both send
 * `{ now: <iso> }`, and a manual run must be the same run — a different shape
 * here would be a second code path that only ever executes when a human asks,
 * which is the path least likely to be noticed when it breaks.
 */
export function payloadFor(_key: RunnableAgentKey, now: Date): Record<string, unknown> {
  return { now: now.toISOString() };
}

/**
 * How long two identical requests are treated as one.
 *
 * `hasAgentRunInFlight` reads `agent_runs`, so it only sees a run the worker
 * has already *started*. Between the job being queued and the worker picking it
 * up there is a window — normally a second, longer if the worker is busy or
 * down — in which a retry would pass every check and queue a second billed
 * Claude call. Bucketing the key closes it in the one place that can: pg-boss
 * itself, which refuses a duplicate rather than racing with us.
 */
const DEDUPE_WINDOW_MS = 60_000;

/**
 * A key that separates a manual run from the scheduled one, and collapses a
 * retry into the run it is retrying.
 *
 * It must differ from the cron key — those are per organisation per day, and
 * reusing one would have pg-boss silently drop the manual run while the caller
 * was told "queued". It must also *not* be unique per millisecond, or a
 * double-tap becomes two invoices' worth of Claude.
 */
export function singletonKeyFor(key: RunnableAgentKey, organisationId: string, now: Date): string {
  const bucket = Math.floor(now.getTime() / DEDUPE_WINDOW_MS);
  return `${key}:${organisationId}:api:${bucket}`;
}
