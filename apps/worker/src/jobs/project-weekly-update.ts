import { PROJECT_REPORTER_KEY } from "@launchos/agents";
import { projectsDueAnUpdate } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { QUEUE, dailyDedupe } from "../boss.js";
import type { AgentRunJob } from "./agent-run.js";
import type { BossSender } from "./dispatch-event.js";
import { sweep, throwOnSweepFailure, type SweepLogger, type SweepSummary } from "./sweep.js";

/**
 * Friday's fan-out: one Project Reporter run per active build.
 *
 * The same shape as the Ad Sentinel's, and for the same reason — a single cron
 * payload cannot carry every organisation, let alone every project, so the
 * schedule wakes this queue and this queue does the fan-out. It differs in
 * going two levels deep: organisations that have the reporter switched on,
 * then the `active` projects inside each.
 *
 * `projectsDueAnUpdate` does the skipping. A `planned` build has nothing to
 * report and an `on_hold` one is waiting on something, where a cheerful weekly
 * note reads as tone-deaf; and a project whose last draft is still sitting in
 * Shoji's approvals queue is left alone, because the pending index would
 * refuse the second card anyway and a run that ends in a refusal is an
 * Opus-priced way of learning nothing.
 */

const FAN_OUT_LABEL = "project weekly update fan-out";

export interface WeeklyUpdateFanOutDeps {
  readonly db: Db;
  readonly boss: BossSender;
  readonly logger?: SweepLogger & { info(...args: unknown[]): void };
}

/** The organisations with the reporter switched on. */
export async function organisationsWithReporter(db: Db): Promise<string[]> {
  const rows = await db
    .select({ organisationId: schema.agentEnablement.organisationId })
    .from(schema.agentEnablement)
    .where(and(
      eq(schema.agentEnablement.agentKey, PROJECT_REPORTER_KEY),
      eq(schema.agentEnablement.enabled, true),
    ));
  return rows.map((row) => row.organisationId);
}

/** One `agent.run` job per project that is due an update, across every enabled organisation. */
export async function buildWeeklyUpdateJobs(db: Db): Promise<AgentRunJob[]> {
  const jobs: AgentRunJob[] = [];
  for (const organisationId of await organisationsWithReporter(db)) {
    for (const project of await projectsDueAnUpdate(db, organisationId)) {
      jobs.push({
        agentKey: PROJECT_REPORTER_KEY,
        organisationId,
        trigger: "cron",
        payload: { projectId: project.projectId },
      });
    }
  }
  return jobs;
}

/**
 * Enqueues them, one project at a time, isolated.
 *
 * The key is `project-reporter:<projectId>:<yyyy-mm-dd>` under a one-day
 * window — an Opus-priced run, the same trade the Sentinel and the Content
 * Writer make. A day is comfortably inside `ARCHIVE_COMPLETED_AFTER_SECONDS`,
 * which since 76f313a is the constraint any `singletonSeconds` has to satisfy:
 * a window longer than the archive interval is refused by pg-boss and the send
 * silently returns null.
 *
 * The window covers `failed` too, so a run that fails on a bad Friday cannot
 * be re-dispatched by this path until the next UTC day. That is the right
 * trade here: nobody is waiting on a weekly note within the hour, and the
 * escape hatch is the admin "draft this week's update" button, which appends a
 * timestamp to the key the way the support-triage "run now" does.
 *
 * One failed enqueue must not cost the other projects their update, so the
 * sends are isolated and the failures re-thrown once at the end.
 */
export async function dispatchWeeklyUpdates(deps: WeeklyUpdateFanOutDeps, now: Date): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
  const day = now.toISOString().slice(0, 10);
  const jobs = await buildWeeklyUpdateJobs(deps.db);
  const summary = await sweep(
    jobs,
    { label: FAN_OUT_LABEL, id: (job) => String(job.payload["projectId"]), logger },
    (job) => deps.boss.send(QUEUE.agentRun, job, dailyDedupe(`project-reporter:${String(job.payload["projectId"])}:${day}`)),
  );
  logger.info({ dispatched: summary.processed, failed: summary.failed }, FAN_OUT_LABEL);
  throwOnSweepFailure(FAN_OUT_LABEL, summary);
  return summary;
}
