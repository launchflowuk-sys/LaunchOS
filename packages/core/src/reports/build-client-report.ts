import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ClientReportStats } from "@launchos/db/schema";
import { and, eq, gte, lt, ne } from "drizzle-orm";
import { recordAudit } from "../audit/record-audit.js";
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

async function collectTaskStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const tasks = await db.select({ status: schema.tasks.status, completedAt: schema.tasks.completedAt })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.organisationId, organisationId), eq(schema.tasks.clientId, clientId)));
  let tasksDone = 0;
  let tasksOpen = 0;
  for (const task of tasks) {
    const done = task.status === "done" && task.completedAt !== null
      && task.completedAt >= period.start && task.completedAt < period.end;
    if (done) tasksDone += 1;
    else if (task.status !== "done" && task.status !== "cancelled") tasksOpen += 1;
  }
  return { tasksDone, tasksOpen };
}

async function collectUptimeStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
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
  if (checks.length === 0) return { uptimePercent: null as number | null };
  return { uptimePercent: (checks.filter((c) => c.ok).length / checks.length) * 100 };
}

async function collectTicketStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const tickets = await db.select({
    status: schema.tickets.status, createdAt: schema.tickets.createdAt,
    updatedAt: schema.tickets.updatedAt, resolvedAt: schema.tickets.resolvedAt,
  })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.organisationId, organisationId), eq(schema.tickets.clientId, clientId)));
  let ticketsOpened = 0;
  let ticketsResolved = 0;
  for (const ticket of tickets) {
    if (ticket.createdAt >= period.start && ticket.createdAt < period.end) ticketsOpened += 1;
    const closed = ticket.status === "resolved" || ticket.status === "closed";
    // Prefer the explicit resolution timestamp; fall back to updatedAt when a
    // ticket was resolved without one being recorded (per plan-writer ruling).
    const resolvedWhen = ticket.resolvedAt ?? (closed ? ticket.updatedAt : null);
    if (closed && resolvedWhen !== null && resolvedWhen >= period.start && resolvedWhen < period.end) {
      ticketsResolved += 1;
    }
  }
  return { ticketsOpened, ticketsResolved };
}

async function collectAdStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
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
  if (adRows.length === 0) return { ads: null as ClientReportStats["ads"] };
  const spendPence = adRows.reduce((s, r) => s + r.spendPence, 0);
  const valuePence = adRows.reduce((s, r) => s + r.conversionValuePence, 0);
  return {
    ads: {
      spendPence,
      clicks: adRows.reduce((s, r) => s + r.clicks, 0),
      conversions: adRows.reduce((s, r) => s + r.conversions, 0),
      roas: spendPence === 0 ? 0 : valuePence / spendPence,
    },
  };
}

async function collectInvoiceStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const invoices = await db.select({ status: schema.invoices.status, totalPence: schema.invoices.totalPence })
    .from(schema.invoices)
    .where(and(
      eq(schema.invoices.organisationId, organisationId),
      eq(schema.invoices.clientId, clientId),
      gte(schema.invoices.issuedAt, period.start),
      lt(schema.invoices.issuedAt, period.end),
    ));
  return {
    invoices: {
      issued: invoices.length,
      paidPence: invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.totalPence, 0),
      outstandingPence: invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + i.totalPence, 0),
    },
  };
}

/**
 * Upserts the draft in one statement so two concurrent builds for the same
 * period cannot race the unique index — the second write lands on conflict
 * rather than throwing a duplicate-key error. The conflict's `WHERE` clause
 * blocks the update outright when the existing row is already published, so
 * a published report can never be silently rewritten under the client's
 * feet; Postgres then reports no row updated, `.returning()` comes back
 * empty, and the already-published row is re-read instead.
 */
async function upsertReport(
  db: Db,
  organisationId: string,
  clientId: string,
  periodStart: string,
  periodEnd: string,
  summaryMd: string,
  stats: ClientReportStats,
) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [written] = await t.insert(schema.clientReports)
      .values({ organisationId, clientId, periodStart, periodEnd, summaryMd, stats })
      .onConflictDoUpdate({
        target: [schema.clientReports.organisationId, schema.clientReports.clientId, schema.clientReports.periodStart],
        set: { periodEnd, summaryMd, stats, updatedAt: new Date() },
        where: ne(schema.clientReports.status, "published"),
      })
      .returning();

    if (written) {
      await recordAudit(t, organisationId, {
        actorKind: "system", action: "client_report.built",
        targetType: "client_report", targetId: written.id, after: written,
      });
      return written;
    }

    const [published] = await t.select().from(schema.clientReports).where(and(
      eq(schema.clientReports.organisationId, organisationId),
      eq(schema.clientReports.clientId, clientId),
      eq(schema.clientReports.periodStart, periodStart),
    ));
    return published!;
  });
}

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

  // Sequential, not Promise.all: every collector reads through the same
  // transaction-scoped connection (the caller is often inside a transaction
  // already), and a single Postgres connection serves one query at a time.
  const taskStats = await collectTaskStats(db, organisationId, clientId, period);
  const uptimeStats = await collectUptimeStats(db, organisationId, clientId, period);
  const ticketStats = await collectTicketStats(db, organisationId, clientId, period);
  const adStats = await collectAdStats(db, organisationId, clientId, period);
  const invoiceStats = await collectInvoiceStats(db, organisationId, clientId, period);
  const stats: ClientReportStats = { ...taskStats, ...uptimeStats, ...ticketStats, ...adStats, ...invoiceStats };

  const summaryMd = renderSummary(client!.name, period, stats);
  const periodStart = isoDay(period.start);
  const periodEnd = isoDay(new Date(period.end.getTime() - 86_400_000));

  return upsertReport(db, organisationId, clientId, periodStart, periodEnd, summaryMd, stats);
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
