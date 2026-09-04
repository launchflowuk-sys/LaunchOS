import { schema, type Db } from "@launchos/db";
import { sweep, throwOnSweepFailure, type SweepLogger, type SweepSummary } from "./sweep.js";

export interface SweepOrganisationsLogger extends SweepLogger {
  info(...args: unknown[]): void;
}

/**
 * Runs `run` once per organisation behind `sweep`, so one organisation whose
 * data throws cannot abort the loop before the rest are touched. The summary
 * is logged, then the collected failures are re-thrown once so pg-boss still
 * marks the job failed and retries it.
 *
 * Lives in its own module rather than inside `main()` so it can be tested with
 * a fake `db` — this is the code that applies isolation to all four cron
 * sweeps, and the bug it exists to prevent shipped precisely because the org
 * loop had no test.
 */
export async function sweepOrganisations(
  db: Db,
  label: string,
  run: (organisationId: string) => Promise<unknown>,
  logger: SweepOrganisationsLogger = console,
): Promise<SweepSummary> {
  const orgs = await db.select({ id: schema.organisations.id }).from(schema.organisations);
  const summary = await sweep(orgs, { label, id: (org) => org.id, logger }, (org) => run(org.id));
  logger.info({ processed: summary.processed, failed: summary.failed }, label);
  throwOnSweepFailure(label, summary);
  return summary;
}
