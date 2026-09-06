import { notifySlaBreaches, type SlaBreachResult } from "@launchos/core";
import type { Db } from "@launchos/db";
import { sweepOrganisations, type SweepOrganisationsLogger } from "./sweep-organisations.js";

/** Every fifteen minutes: a four-hour promise missed by up to a quarter of an hour is close enough to say so. */
export const SLA_SWEEP_CRON = "*/15 * * * *";

export interface SlaSweepResult {
  organisations: number;
  breached: number;
  notified: number;
}

/**
 * The first-response SLA sweep: for every organisation, each open,
 * client-visible case with no first response after the promised hours gets
 * a `case.sla_breached` notification to the owner and the assignee — once,
 * because `notifySlaBreaches` stamps the ticket. The whole job is that one
 * core call per organisation behind `sweepOrganisations`, so one tenant's
 * failure cannot stop the others being checked.
 */
export async function runSlaSweep(db: Db, now: Date, logger: SweepOrganisationsLogger = console): Promise<SlaSweepResult> {
  const totals = { organisations: 0, breached: 0, notified: 0 };
  await sweepOrganisations(db, "support SLA sweep", async (organisationId) => {
    const result: SlaBreachResult = await notifySlaBreaches(db, organisationId, { now });
    totals.organisations += 1;
    totals.breached += result.breached;
    totals.notified += result.notified.length;
    if (result.breached > 0) logger.info({ organisationId, hours: result.hours, breached: result.breached, notified: result.notified }, "SLA breaches");
  }, logger);
  return { ...totals };
}
