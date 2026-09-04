import { buildClientReport, monthPeriod } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";

export interface MonthlyReportsResult {
  clients: number;
  reports: number;
  periodStart: string;
}

/** Drafts last month's report for every active client. Runs on the 1st. */
export async function runMonthlyReports(
  db: Db,
  organisationId: string,
  options: { now: Date },
): Promise<MonthlyReportsResult> {
  const period = monthPeriod(options.now);
  const clients = await db.select({ id: schema.clients.id }).from(schema.clients).where(and(
    eq(schema.clients.organisationId, organisationId),
    eq(schema.clients.status, "active"),
    isNull(schema.clients.deletedAt),
  ));
  let reports = 0;
  for (const client of clients) {
    await buildClientReport(db, organisationId, client.id, period);
    reports += 1;
  }
  return { clients: clients.length, reports, periodStart: period.start.toISOString().slice(0, 10) };
}
