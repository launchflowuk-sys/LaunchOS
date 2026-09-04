import { generateOnboardingTasks, generateRecurringTasks, notifyOverdueTasks } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";

export type GenerateOnboardingJob = { organisationId: string; clientId: string };

export async function handleGenerateOnboarding(db: Db, job: GenerateOnboardingJob) {
  const { created, skipped } = await generateOnboardingTasks(db, job.organisationId, job.clientId);
  return { created: created.length, skipped };
}

async function organisationIds(db: Db) {
  const rows = await db.select({ id: schema.organisations.id }).from(schema.organisations)
    .where(eq(schema.organisations.status, "active"));
  return rows.map((r) => r.id);
}

export interface RecurringSweepDeps { generateRecurringTasks: typeof generateRecurringTasks; }
const defaultRecurringSweepDeps: RecurringSweepDeps = { generateRecurringTasks };

/**
 * Daily 06:00 Europe/London: this period's service work for every organisation.
 * One organisation's failure is logged and does not stop the rest; if any
 * organisation failed, the sweep still throws once every organisation has
 * been attempted, so pg-boss retries the job.
 */
export async function runRecurringSweep(db: Db, now: Date, deps: RecurringSweepDeps = defaultRecurringSweepDeps) {
  const ids = await organisationIds(db);
  let created = 0;
  let skipped = 0;
  const failedOrganisationIds: string[] = [];
  for (const organisationId of ids) {
    try {
      const result = await deps.generateRecurringTasks(db, organisationId, { now });
      created += result.created;
      skipped += result.skipped;
    } catch (error) {
      console.error({ organisationId, error }, "recurring task sweep failed for organisation");
      failedOrganisationIds.push(organisationId);
    }
  }
  if (failedOrganisationIds.length > 0) {
    throw new Error(`recurring task sweep failed for ${failedOrganisationIds.length} of ${ids.length} organisation(s): ${failedOrganisationIds.join(", ")}`);
  }
  return { organisations: ids.length, created, skipped };
}

export interface OverdueSweepDeps { notifyOverdueTasks: typeof notifyOverdueTasks; }
const defaultOverdueSweepDeps: OverdueSweepDeps = { notifyOverdueTasks };

/**
 * Daily 08:00 Europe/London: chase everything past its due date. Same
 * per-organisation isolation as the recurring sweep.
 */
export async function runOverdueSweep(db: Db, now: Date, deps: OverdueSweepDeps = defaultOverdueSweepDeps) {
  const ids = await organisationIds(db);
  let overdue = 0;
  let notified = 0;
  const failedOrganisationIds: string[] = [];
  for (const organisationId of ids) {
    try {
      const result = await deps.notifyOverdueTasks(db, organisationId, { now });
      overdue += result.overdue;
      notified += result.notified;
    } catch (error) {
      console.error({ organisationId, error }, "overdue task sweep failed for organisation");
      failedOrganisationIds.push(organisationId);
    }
  }
  if (failedOrganisationIds.length > 0) {
    throw new Error(`overdue task sweep failed for ${failedOrganisationIds.length} of ${ids.length} organisation(s): ${failedOrganisationIds.join(", ")}`);
  }
  return { organisations: ids.length, overdue, notified };
}
