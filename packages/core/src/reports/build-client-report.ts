import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ClientReportStats } from "@launchos/db/schema";
import { and, count, eq, gte, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import type { RecordAuditInput } from "../audit/record-audit.js";
import { recordAudit } from "../audit/record-audit.js";
import { zonedDateKey } from "../meetings/time.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import {
  collectContentStats, collectIncidentStats, collectPaymentStats, collectSatisfactionStats,
} from "./monthly-collectors.js";

export interface ReportPeriod {
  start: Date;
  end: Date;
}

/** Who asked for the build. The monthly cron is `system`; the admin portal passes the signed-in user. */
export interface ReportActor {
  actorKind: RecordAuditInput["actorKind"];
  actorId?: string;
}

const SYSTEM_ACTOR: ReportActor = { actorKind: "system" };

/** The calendar month that ended before `now`, in UTC. */
export function monthPeriod(now: Date): ReportPeriod {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end };
}

/**
 * Every date in a report is read in London, because the business is in Essex
 * and the client reads "August" as August here. It matters at exactly one
 * instant a year's worth of reports: in British Summer Time a calendar month
 * begins at 23:00 UTC the evening before, so a UTC day-key would file the
 * London month of August under `2026-07-31`.
 */
export const REPORT_TIME_ZONE = "Europe/London";

const isoDay = (value: Date) => zonedDateKey(value, REPORT_TIME_ZONE);
/** `YYYY-MM` for the month a period covers — how `content_reports` keys a month. */
const periodKeyOf = (period: ReportPeriod) => isoDay(period.start).slice(0, 7);
const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;

/** Neither outstanding work nor delivered work: excluded from both task counters. */
const OPEN_TASK_EXCLUDED: (typeof schema.taskStatusEnum.enumValues)[number][] = ["done", "cancelled"];
const CLOSED_TICKET_STATUSES: (typeof schema.ticketStatusEnum.enumValues)[number][] = ["resolved", "closed"];

/**
 * Both counters are bounded to the report period and aggregated in SQL — a
 * client three years into a retainer must not pull every task it has ever had
 * into the worker's memory once a month.
 *
 * - `tasksDone`: completed *inside* the period (`status = 'done'` with
 *   `completed_at` in `[start, end)`).
 * - `tasksOpen`: still open **as at the period end** — it existed by then
 *   (`created_at < end`) and is not `done`/`cancelled` today. Open work has no
 *   period of its own, so the count is "what is outstanding", narrowed to
 *   tasks that had been raised by the close of the month being reported on;
 *   work raised after the period does not belong in that month's report. The
 *   status is read as it stands now rather than as it stood at the period end
 *   — reconstructing historical status would need an event log we do not keep.
 */
async function collectTaskStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const scope = and(eq(schema.tasks.organisationId, organisationId), eq(schema.tasks.clientId, clientId));

  const [done] = await db.select({ value: count() }).from(schema.tasks).where(and(
    scope,
    eq(schema.tasks.status, "done"),
    gte(schema.tasks.completedAt, period.start),
    lt(schema.tasks.completedAt, period.end),
  ));

  const [open] = await db.select({ value: count() }).from(schema.tasks).where(and(
    scope,
    notInArray(schema.tasks.status, OPEN_TASK_EXCLUDED),
    lt(schema.tasks.createdAt, period.end),
  ));

  return { tasksDone: done!.value, tasksOpen: open!.value };
}

/**
 * Aggregated in SQL, for the same reason as `collectTaskStats`: a monitor
 * checked every minute produces ~43,000 rows a month *per site*, and the
 * previous version pulled every one of them into the worker to count how many
 * were `true`. Nothing but the ratio was ever used.
 *
 * `null` when the period holds no checks at all — a site added mid-month, or
 * monitoring switched off — which is a different statement from 0% and is
 * rendered as one.
 */
async function collectUptimeStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const [row] = await db.select({
    total: count(),
    ok: sql<number>`count(*) filter (where ${schema.uptimeChecks.ok})`.mapWith(Number),
  })
    .from(schema.uptimeChecks)
    .innerJoin(schema.monitors, eq(schema.uptimeChecks.monitorId, schema.monitors.id))
    .innerJoin(schema.sites, eq(schema.monitors.siteId, schema.sites.id))
    .where(and(
      eq(schema.uptimeChecks.organisationId, organisationId),
      eq(schema.monitors.organisationId, organisationId),
      eq(schema.sites.organisationId, organisationId),
      eq(schema.sites.clientId, clientId),
      gte(schema.uptimeChecks.checkedAt, period.start),
      lt(schema.uptimeChecks.checkedAt, period.end),
    ));
  if (!row || row.total === 0) return { uptimePercent: null as number | null };
  return { uptimePercent: (row.ok / row.total) * 100 };
}

/**
 * The currency the money figures in this report are denominated in.
 *
 * Every `*Pence` total above is a plain integer sum, so it only means anything
 * once a reader knows what it is counting. Both sources are per-row — an ad
 * account and an invoice each carry their own `currency` — so the honest answer
 * is only available when they all agree. One distinct value across the client's
 * ad accounts and the invoices issued in the period is that answer; anything
 * else is `null`, because a client billed in two currencies has totals that
 * are sums of unlike things and labelling them with either one would be a lie.
 * No rows at all is `null` for the same reason: there is nothing to read it off.
 */
async function collectCurrency(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const [fromAds, fromInvoices] = [
    await db.selectDistinct({ currency: schema.adAccounts.currency })
      .from(schema.adAccounts)
      .where(and(
        eq(schema.adAccounts.organisationId, organisationId),
        eq(schema.adAccounts.clientId, clientId),
      )),
    await db.selectDistinct({ currency: schema.invoices.currency })
      .from(schema.invoices)
      .where(and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.clientId, clientId),
        gte(schema.invoices.issuedAt, period.start),
        lt(schema.invoices.issuedAt, period.end),
      )),
  ];
  const distinct = new Set([...fromAds, ...fromInvoices].map((r) => r.currency));
  return { currency: distinct.size === 1 ? [...distinct][0]! : null };
}

/**
 * Both counters are bounded to the report period and aggregated in SQL, for
 * the same reason as `collectTaskStats`.
 *
 * - `ticketsOpened`: raised inside the period (`created_at` in `[start, end)`).
 * - `ticketsResolved`: `resolved`/`closed` whose resolution timestamp falls in
 *   the period. Per the plan-writer ruling the timestamp is `resolved_at` when
 *   set, falling back to `updated_at` for tickets closed before that column was
 *   populated — hence `coalesce(resolved_at, updated_at)`.
 */
async function collectTicketStats(db: Db, organisationId: string, clientId: string, period: ReportPeriod) {
  const scope = and(eq(schema.tickets.organisationId, organisationId), eq(schema.tickets.clientId, clientId));

  const [opened] = await db.select({ value: count() }).from(schema.tickets).where(and(
    scope,
    gte(schema.tickets.createdAt, period.start),
    lt(schema.tickets.createdAt, period.end),
  ));

  // Bound as ISO strings: a raw `sql` fragment has no column to borrow a driver
  // encoder from, so a Date object would reach postgres-js unserialised.
  const resolvedWhen = sql`coalesce(${schema.tickets.resolvedAt}, ${schema.tickets.updatedAt})`;
  const [resolved] = await db.select({ value: count() }).from(schema.tickets).where(and(
    scope,
    inArray(schema.tickets.status, CLOSED_TICKET_STATUSES),
    sql`${resolvedWhen} >= ${period.start.toISOString()}::timestamptz`,
    sql`${resolvedWhen} < ${period.end.toISOString()}::timestamptz`,
  ));

  return { ticketsOpened: opened!.value, ticketsResolved: resolved!.value };
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
      eq(schema.adAccounts.organisationId, organisationId),
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
 *
 * `before` is the row as it stood at the start of this transaction — `null`
 * for a fresh insert, the prior draft for a rebuild — so the audit trail can
 * show what a rebuild replaced, not just what it wrote.
 *
 * Takes the caller's transaction; `buildClientReport` owns it.
 */
async function upsertReport(
  tx: Db,
  organisationId: string,
  clientId: string,
  periodStart: string,
  periodEnd: string,
  summaryMd: string,
  stats: ClientReportStats,
  actor: ReportActor,
) {
  const identity = and(
    eq(schema.clientReports.organisationId, organisationId),
    eq(schema.clientReports.clientId, clientId),
    eq(schema.clientReports.periodStart, periodStart),
  );

  const [before] = await tx.select().from(schema.clientReports).where(identity);

  const [written] = await tx.insert(schema.clientReports)
    .values({ organisationId, clientId, periodStart, periodEnd, summaryMd, stats })
    .onConflictDoUpdate({
      target: [schema.clientReports.organisationId, schema.clientReports.clientId, schema.clientReports.periodStart],
      set: { periodEnd, summaryMd, stats, updatedAt: new Date() },
      where: ne(schema.clientReports.status, "published"),
    })
    .returning();

  if (written) {
    await recordAudit(tx, organisationId, {
      actorKind: actor.actorKind, actorId: actor.actorId, action: "client_report.built",
      targetType: "client_report", targetId: written.id, before: before ?? null, after: written,
    });
    return written;
  }

  const [published] = await tx.select().from(schema.clientReports).where(identity);
  return published!;
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
  actor: ReportActor = SYSTEM_ACTOR,
) {
  // One transaction for the whole build: every collector must read from a
  // single snapshot, or a webhook committing mid-build lands in one number and
  // not the others and the report contradicts itself. Sequential, not
  // Promise.all: a transaction holds one Postgres connection, which serves one
  // query at a time.
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;

    await assertOwned(tx, organisationId, schema.clients, clientId);
    const [client] = await tx.select().from(schema.clients).where(and(
      eq(schema.clients.id, clientId),
      eq(schema.clients.organisationId, organisationId),
    ));

    const taskStats = await collectTaskStats(tx, organisationId, clientId, period);
    const uptimeStats = await collectUptimeStats(tx, organisationId, clientId, period);
    const ticketStats = await collectTicketStats(tx, organisationId, clientId, period);
    const adStats = await collectAdStats(tx, organisationId, clientId, period);
    const invoiceStats = await collectInvoiceStats(tx, organisationId, clientId, period);
    const currency = await collectCurrency(tx, organisationId, clientId, period);
    // The four the monthly account report added. Same transaction, same
    // snapshot: a webhook committing mid-build must not land in one number and
    // not the others.
    const incidentStats = await collectIncidentStats(tx, organisationId, clientId, period);
    const contentStats = await collectContentStats(tx, organisationId, clientId, periodKeyOf(period));
    const satisfactionStats = await collectSatisfactionStats(tx, organisationId, clientId, period);
    const paymentStats = await collectPaymentStats(tx, organisationId, clientId, period);
    const stats: ClientReportStats = {
      ...taskStats, ...uptimeStats, ...ticketStats, ...adStats, ...invoiceStats, ...currency,
      ...incidentStats, ...contentStats, ...satisfactionStats, ...paymentStats,
    };

    const summaryMd = renderSummary(client!.name, period, stats);
    const periodStart = isoDay(period.start);
    const periodEnd = isoDay(new Date(period.end.getTime() - 86_400_000));

    return upsertReport(tx, organisationId, clientId, periodStart, periodEnd, summaryMd, stats, actor);
  });
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
  if (stats.satisfaction) {
    lines.push(`- Rated ${stats.satisfaction.averageScore} out of 5 across ${stats.satisfaction.responses} response${stats.satisfaction.responses === 1 ? "" : "s"}.`);
  }
  if (stats.incidents && (stats.incidents.opened > 0 || stats.incidents.openAtPeriodEnd > 0)) {
    lines.push(
      "",
      "## Incidents",
      `- ${stats.incidents.opened} raised, ${stats.incidents.resolved} resolved${stats.incidents.openAtPeriodEnd > 0 ? `, ${stats.incidents.openAtPeriodEnd} still open at the end of the month` : ""}.`,
    );
  }
  if (stats.ads) {
    lines.push(
      "",
      "## Advertising",
      `- Spend ${pounds(stats.ads.spendPence)} for ${stats.ads.clicks} clicks and ${stats.ads.conversions} conversions.`,
      `- Return on ad spend ${stats.ads.roas.toFixed(2)}x.`,
    );
  }
  if (stats.content) {
    lines.push(
      "",
      "## Content",
      `- ${stats.content.published} of ${stats.content.planned} planned posts published.`,
    );
  }
  lines.push(
    "",
    "## Billing",
    `- ${stats.invoices.issued} invoices issued, ${pounds(stats.invoices.paidPence)} paid, ${pounds(stats.invoices.outstandingPence)} outstanding.`,
  );
  if (stats.payments && stats.payments.received > 0) {
    lines.push(`- ${pounds(stats.payments.receivedPence)} received across ${stats.payments.received} payment${stats.payments.received === 1 ? "" : "s"}.`);
  }
  return lines.join("\n");
}
