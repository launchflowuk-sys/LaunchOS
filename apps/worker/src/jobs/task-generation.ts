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

/** Daily 06:00 Europe/London: this period's service work for every organisation. */
export async function runRecurringSweep(db: Db, now: Date) {
  const ids = await organisationIds(db);
  let created = 0;
  let skipped = 0;
  for (const organisationId of ids) {
    const result = await generateRecurringTasks(db, organisationId, { now });
    created += result.created;
    skipped += result.skipped;
  }
  return { organisations: ids.length, created, skipped };
}

/** Daily 08:00 Europe/London: chase everything past its due date. */
export async function runOverdueSweep(db: Db, now: Date) {
  const ids = await organisationIds(db);
  let overdue = 0;
  let notified = 0;
  for (const organisationId of ids) {
    const result = await notifyOverdueTasks(db, organisationId, { now });
    overdue += result.overdue;
    notified += result.notified;
  }
  return { organisations: ids.length, overdue, notified };
}
