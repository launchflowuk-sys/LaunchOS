import { AD_SENTINEL_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { QUEUE, dailyDedupe } from "../boss.js";
import type { AgentRunJob } from "./agent-run.js";
import type { BossSender } from "./dispatch-event.js";
import { sweep, throwOnSweepFailure, type SweepLogger, type SweepSummary } from "./sweep.js";

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

export interface SentinelFanOutDeps {
  readonly db: Db;
  readonly boss: BossSender;
  readonly logger?: SweepLogger & { info(...args: unknown[]): void };
}

const FAN_OUT_LABEL = "ad sentinel fan-out";

/**
 * Enqueues one `agent.run` per enabled organisation.
 *
 * Lives here rather than inline in `index.ts` so it can be run against a fake
 * boss: the dedupe key and the per-organisation isolation are the two things
 * that go wrong, and neither was reachable by a test while this sat inside
 * `main()`.
 *
 * The key is `ad-sentinel:<org>:<yyyy-mm-dd>` under a one-day window, so a
 * retry of this fan-out — or a second cron tick — cannot start a second
 * Opus-priced Sentinel run for an organisation already dispatched. Note the
 * window covers `failed` too: if an organisation's run itself fails, it cannot
 * be re-dispatched by this path until the next UTC day (see `dailyDedupe`).
 * One failed enqueue must not cost the remaining organisations their run, so
 * the sends are isolated and the failures re-thrown once at the end.
 */
export async function dispatchSentinelRuns(deps: SentinelFanOutDeps, now: Date): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
  const day = now.toISOString().slice(0, 10);
  const jobs = await buildSentinelJobs(deps.db, now);
  const summary = await sweep(
    jobs,
    { label: FAN_OUT_LABEL, id: (job) => job.organisationId, logger },
    (job) => deps.boss.send(QUEUE.agentRun, job, dailyDedupe(`ad-sentinel:${job.organisationId}:${day}`)),
  );
  logger.info({ dispatched: summary.processed, failed: summary.failed }, FAN_OUT_LABEL);
  throwOnSweepFailure(FAN_OUT_LABEL, summary);
  return summary;
}
