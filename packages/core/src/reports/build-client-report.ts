import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ClientReportStats } from "@launchos/db/schema";
import { and, eq, gte, lt } from "drizzle-orm";
import { assertOwned } from "../tenancy/assert-owned.js";

export interface ReportPeriod {
  start: Date;
  end: Date;
}

/** The calendar month that ended before `now`, in UTC. */
export function monthPeriod(now: Date): ReportPeriod {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end };
}

const isoDay = (value: Date) => value.toISOString().slice(0, 10);
const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;

/**
 * Assembles one month of a client's work into `client_reports`.
 *
 * Written as a draft the owner reviews before publishing — the client never
 * sees a report LaunchOS generated unread. Rebuilding the same period updates
 * the existing row unless it has already been published, so the monthly cron
 * is safe to re-run.
 */
export async function buildClientReport(
  db: Db,
  organisationId: string,
  clientId: string,
  period: ReportPeriod,
) {
  await assertOwned(db, organisationId, schema.clients, clientId);
  const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));

  const stats: ClientReportStats = {
    tasksDone: 0, tasksOpen: 0, uptimePercent: null, ticketsOpened: 0, ticketsResolved: 0,
    ads: null, invoices: { issued: 0, paidPence: 0, outstandingPence: 0 },
  };

  const tasks = await db.select({ status: schema.tasks.status, completedAt: schema.tasks.completedAt })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.organisationId, organisationId), eq(schema.tasks.clientId, clientId)));
  for (const task of tasks) {
    const done = task.status === "done" && task.completedAt !== null
      && task.completedAt >= period.start && task.completedAt < period.end;
    if (done) stats.tasksDone += 1;
    else if (task.status !== "done" && task.status !== "cancelled") stats.tasksOpen += 1;
  }

  const checks = await db.select({ ok: schema.uptimeChecks.ok })
    .from(schema.uptimeChecks)
    .innerJoin(schema.monitors, eq(schema.uptimeChecks.monitorId, schema.monitors.id))
    .innerJoin(schema.sites, eq(schema.monitors.siteId, schema.sites.id))
    .where(and(
      eq(schema.uptimeChecks.organisationId, organisationId),
      eq(schema.sites.clientId, clientId),
      gte(schema.uptimeChecks.checkedAt, period.start),
      lt(schema.uptimeChecks.checkedAt, period.end),
    ));
  if (checks.length > 0) {
    stats.uptimePercent = (checks.filter((c) => c.ok).length / checks.length) * 100;
  }

  const tickets = await db.select({
    status: schema.tickets.status, createdAt: schema.tickets.createdAt,
    updatedAt: schema.tickets.updatedAt, resolvedAt: schema.tickets.resolvedAt,
  })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.organisationId, organisationId), eq(schema.tickets.clientId, clientId)));
  for (const ticket of tickets) {
    if (ticket.createdAt >= period.start && ticket.createdAt < period.end) stats.ticketsOpened += 1;
    const closed = ticket.status === "resolved" || ticket.status === "closed";
    // Prefer the explicit resolution timestamp; fall back to updatedAt when a
    // ticket was resolved without one being recorded (per plan-writer ruling).
    const resolvedWhen = ticket.resolvedAt ?? (closed ? ticket.updatedAt : null);
    if (closed && resolvedWhen !== null && resolvedWhen >= period.start && resolvedWhen < period.end) {
      stats.ticketsResolved += 1;
    }
  }

  const adRows = await db.select({
    spendPence: schema.adMetricSnapshots.spendPence,
    clicks: schema.adMetricSnapshots.clicks,
    conversions: schema.adMetricSnapshots.conversions,
    conversionValuePence: schema.adMetricSnapshots.conversionValuePence,
  })
    .from(schema.adMetricSnapshots)
    .innerJoin(schema.adAccounts, eq(schema.adMetricSnapshots.adAccountId, schema.adAccounts.id))
    .where(and(
      eq(schema.adMetricSnapshots.organisationId, organisationId),
      eq(schema.adAccounts.clientId, clientId),
      gte(schema.adMetricSnapshots.date, isoDay(period.start)),
      lt(schema.adMetricSnapshots.date, isoDay(period.end)),
    ));
  if (adRows.length > 0) {
    const spendPence = adRows.reduce((s, r) => s + r.spendPence, 0);
    const valuePence = adRows.reduce((s, r) => s + r.conversionValuePence, 0);
    stats.ads = {
      spendPence,
      clicks: adRows.reduce((s, r) => s + r.clicks, 0),
      conversions: adRows.reduce((s, r) => s + r.conversions, 0),
      roas: spendPence === 0 ? 0 : valuePence / spendPence,
    };
  }

  const invoices = await db.select({ status: schema.invoices.status, totalPence: schema.invoices.totalPence })
    .from(schema.invoices)
    .where(and(
      eq(schema.invoices.organisationId, organisationId),
      eq(schema.invoices.clientId, clientId),
      gte(schema.invoices.issuedAt, period.start),
      lt(schema.invoices.issuedAt, period.end),
    ));
  stats.invoices = {
    issued: invoices.length,
    paidPence: invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.totalPence, 0),
    outstandingPence: invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + i.totalPence, 0),
  };

  const summaryMd = renderSummary(client!.name, period, stats);
  const periodStart = isoDay(period.start);
  const periodEnd = isoDay(new Date(period.end.getTime() - 86_400_000));

  const [existing] = await db.select().from(schema.clientReports).where(and(
    eq(schema.clientReports.organisationId, organisationId),
    eq(schema.clientReports.clientId, clientId),
    eq(schema.clientReports.periodStart, periodStart),
  ));
  // A published report is what the client has already read; regenerating it
  // under their feet would rewrite history.
  if (existing?.status === "published") return existing;

  const [row] = existing
    ? await db.update(schema.clientReports)
      .set({ periodEnd, summaryMd, stats, updatedAt: new Date() })
      .where(eq(schema.clientReports.id, existing.id))
      .returning()
    : await db.insert(schema.clientReports)
      .values({ organisationId, clientId, periodStart, periodEnd, summaryMd, stats })
      .returning();
  return row!;
}

function renderSummary(clientName: string, period: ReportPeriod, stats: ClientReportStats): string {
  const month = period.start.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const lines = [
    `# ${clientName} — ${month}`,
    "",
    "## Work delivered",
    `- ${stats.tasksDone} tasks completed this month, ${stats.tasksOpen} still in flight.`,
    "",
    "## Hosting",
    stats.uptimePercent === null
      ? "- No uptime checks recorded for this period."
      : `- Uptime ${stats.uptimePercent.toFixed(2)}% across your monitored sites.`,
    "",
    "## Support",
    `- ${stats.ticketsOpened} requests raised, ${stats.ticketsResolved} resolved.`,
  ];
  if (stats.ads) {
    lines.push(
      "",
      "## Advertising",
      `- Spend ${pounds(stats.ads.spendPence)} for ${stats.ads.clicks} clicks and ${stats.ads.conversions} conversions.`,
      `- Return on ad spend ${stats.ads.roas.toFixed(2)}x.`,
    );
  }
  lines.push(
    "",
    "## Billing",
    `- ${stats.invoices.issued} invoices issued, ${pounds(stats.invoices.paidPence)} paid, ${pounds(stats.invoices.outstandingPence)} outstanding.`,
  );
  return lines.join("\n");
}
