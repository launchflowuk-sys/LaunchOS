import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ClientReportStats } from "@launchos/db/schema";
import { and, count, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { ReportPeriod } from "./build-client-report.js";

/**
 * The four figures the monthly account report added to `buildClientReport`.
 *
 * They live in their own file for size, not for separation: `build-client-report.ts`
 * calls every one of them inside its single transaction, so the whole report is
 * still read from one snapshot and cannot contradict itself. Each is aggregated
 * in SQL and bounded to the period, for the reason the uptime collector already
 * gives — a client three years into a retainer must not have their whole history
 * pulled into the worker once a month.
 */

/**
 * What went wrong, and whether it was put right.
 *
 * Three counts rather than one, because the honest sentence needs all three:
 * how many times something broke, how many of those we fixed, and whether
 * anything was still broken when the month ended. `openAtPeriodEnd` is read as
 * at the period end rather than as at today — a report about August must not
 * change its mind in November.
 */
export async function collectIncidentStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const scope = and(
    eq(schema.incidents.organisationId, organisationId),
    eq(schema.sites.organisationId, organisationId),
    eq(schema.sites.clientId, clientId),
  );
  const from = (where: ReturnType<typeof and>) =>
    db.select({ value: count() })
      .from(schema.incidents)
      .innerJoin(schema.sites, eq(schema.sites.id, schema.incidents.siteId))
      .where(where);

  const [opened] = await from(and(scope, gte(schema.incidents.openedAt, period.start), lt(schema.incidents.openedAt, period.end)));
  const [resolved] = await from(and(scope, gte(schema.incidents.resolvedAt, period.start), lt(schema.incidents.resolvedAt, period.end)));
  const [openAtEnd] = await from(and(
    scope,
    lt(schema.incidents.openedAt, period.end),
    or(isNull(schema.incidents.resolvedAt), gte(schema.incidents.resolvedAt, period.end)),
  ));

  return {
    incidents: {
      opened: opened!.value,
      resolved: resolved!.value,
      openAtPeriodEnd: openAtEnd!.value,
    } satisfies NonNullable<ClientReportStats["incidents"]>,
  };
}

/**
 * What was published, taken from the content report rather than counted again.
 *
 * `buildContentReport` is the authority on what "published" and "planned" mean
 * for a month, and it runs at 07:00 on the 1st — before this report does, on
 * purpose. Reading its row means the two documents a client receives cannot
 * disagree about the same month, which counting the items a second time here
 * would eventually allow. `null` when no content report exists: a client with
 * no content plan has nothing to say here, and inventing a zero would read as
 * "we published nothing for you".
 */
export async function collectContentStats(db: Db, organisationId: string, clientId: string, periodKey: string) {
  const [report] = await db.select({ stats: schema.contentReports.stats })
    .from(schema.contentReports)
    .where(and(
      eq(schema.contentReports.organisationId, organisationId),
      eq(schema.contentReports.clientId, clientId),
      eq(schema.contentReports.periodKey, periodKey),
    ));
  if (!report) return { content: null as NonNullable<ClientReportStats["content"]> | null };
  return {
    content: {
      published: report.stats.published ?? 0,
      planned: report.stats.planned ?? 0,
    },
  };
}

/**
 * How the month's handled cases were rated.
 *
 * Keyed on when the client *rated*, not when the case was raised: a five out
 * of five clicked in August is August's news even if the case was opened in
 * July. `null` when nobody rated anything — an average of no scores is not
 * zero, and printing one would be a lie about a client who simply did not
 * answer.
 */
export async function collectSatisfactionStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const [row] = await db.select({
    responses: count(),
    total: sql<number>`coalesce(sum(${schema.ticketRatings.score}), 0)`.mapWith(Number),
  })
    .from(schema.ticketRatings)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketRatings.ticketId))
    .where(and(
      eq(schema.ticketRatings.organisationId, organisationId),
      eq(schema.tickets.organisationId, organisationId),
      eq(schema.tickets.clientId, clientId),
      gte(schema.ticketRatings.ratedAt, period.start),
      lt(schema.ticketRatings.ratedAt, period.end),
    ));
  if (!row || row.responses === 0) return { satisfaction: null as NonNullable<ClientReportStats["satisfaction"]> | null };
  return {
    satisfaction: {
      responses: row.responses,
      averageScore: Math.round((row.total / row.responses) * 100) / 100,
    },
  };
}

/**
 * Money actually received in the period, however it arrived.
 *
 * Separate from `invoices.paidPence`, which is "invoices issued this month
 * that are now paid". The two answer different questions and a client asks
 * both: what did you bill me, and what did I pay. Only `succeeded` payments
 * count; a failed card is not money.
 */
export async function collectPaymentStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const [row] = await db.select({
    received: count(),
    total: sql<number>`coalesce(sum(${schema.payments.amountPence}), 0)`.mapWith(Number),
  })
    .from(schema.payments)
    .where(and(
      eq(schema.payments.organisationId, organisationId),
      eq(schema.payments.clientId, clientId),
      eq(schema.payments.status, "succeeded"),
      gte(schema.payments.paidAt, period.start),
      lt(schema.payments.paidAt, period.end),
    ));
  return {
    payments: { received: row?.received ?? 0, receivedPence: row?.total ?? 0 },
  };
}
