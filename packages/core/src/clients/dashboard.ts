import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, avg, count, desc, eq, gt, gte, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";

/**
 * Everything a client's dashboard puts on screen, in one read.
 *
 * Gathered here rather than in the page because the figures have to agree with
 * each other. "99.9% uptime" beside "2 incidents" beside a chart drawn from a
 * third query is three chances to contradict yourself; one function over one
 * `now` is none.
 *
 * **Only figures the database can stand behind.** The design this implements
 * also asked for backups, a security score and visitor counts. Nothing in
 * LaunchOS records any of the three, and inventing them on a client's own
 * dashboard is the difference between software and a screenshot. What is here
 * instead is real: `uptime_checks` stores `latency_ms` on every check, so
 * response time and its trend are measured rather than claimed.
 */

/** The window every "this month" figure uses, and the chart's length. */
export const DASHBOARD_WINDOW_DAYS = 30;

/** How many points the response-time chart draws. One per day is legible at any width. */
const CHART_POINTS = 30;

export interface DashboardTrend {
  /** Percentage change against the previous window, rounded. Negative is a fall. */
  changePercent: number;
  /** Whether the change is good news, which is not the same as whether it went up. */
  good: boolean;
}

export interface UptimeSummary {
  /** Null when nothing has ever been checked — not zero, which would read as "always down". */
  percent: number | null;
  /** Average response in milliseconds over the window, null when unmeasured. */
  responseMs: number | null;
  /** Response time against the previous window. Faster is better, so a fall is good. */
  responseTrend: DashboardTrend | null;
  /** When the site was last checked at all. */
  lastCheckedAt: Date | null;
  /** Whether the most recent check passed. */
  up: boolean | null;
  /** One point per day, oldest first, for the chart. */
  responseSeries: readonly number[];
}

export interface DashboardSite {
  id: string;
  name: string;
  primaryUrl: string;
  status: string;
  /** Whether a screenshot has actually been captured, so the UI can say "not yet" honestly. */
  hasScreenshot: boolean;
}

export interface DashboardWork {
  inProgress: number;
  waitingOnClient: number;
  doneThisWindow: number;
}

export interface DashboardSupport {
  open: number;
  resolvedThisWindow: number;
  /** Median-ish: the mean hours from raised to first reply, over the window. Null when nothing was answered. */
  firstResponseHours: number | null;
}

export interface ClientDashboard {
  site: DashboardSite | null;
  uptime: UptimeSummary;
  domain: { name: string; expiresAt: Date | null } | null;
  plan: { amountPence: number; currency: string; status: string; renewsAt: Date | null } | null;
  work: DashboardWork;
  support: DashboardSupport;
  /** Incidents opened in the window, and how many of those are closed off. */
  incidents: { opened: number; resolved: number };
  invoices: { outstandingPence: number; outstandingCount: number };
  contentPublishedThisWindow: number;
  activity: readonly {
    id: string; kind: string; title: string; body: string | null; link: string | null; createdAt: Date;
  }[];
}

/** Closed, for a ticket. Matches the portal's own reading of "not waiting on us". */
const CLOSED_TICKETS = ["resolved", "closed"] as const;

/** Statuses that mean a task is still live work. */
const LIVE_TASKS = ["todo", "in_progress", "blocked", "review"] as const;

/** A percentage change, guarding the divide. */
function changeOf(current: number, previous: number, lowerIsBetter: boolean): DashboardTrend | null {
  if (previous === 0) return null;
  const changePercent = Math.round(((current - previous) / previous) * 100);
  if (changePercent === 0) return null;
  return { changePercent, good: lowerIsBetter ? changePercent < 0 : changePercent > 0 };
}

/** Uptime, response time and the chart, for one site. */
async function uptimeFor(db: Db, organisationId: string, siteId: string, now: Date): Promise<UptimeSummary> {
  const windowStart = new Date(now.getTime() - DASHBOARD_WINDOW_DAYS * 86_400_000);
  const previousStart = new Date(now.getTime() - DASHBOARD_WINDOW_DAYS * 2 * 86_400_000);

  const scoped = (from: Date, to: Date) =>
    db
      .select({
        total: count(),
        ok: sql<number>`sum(case when ${schema.uptimeChecks.ok} then 1 else 0 end)::int`,
        latency: avg(schema.uptimeChecks.latencyMs),
      })
      .from(schema.uptimeChecks)
      .innerJoin(schema.monitors, eq(schema.monitors.id, schema.uptimeChecks.monitorId))
      .where(and(
        eq(schema.uptimeChecks.organisationId, organisationId),
        eq(schema.monitors.siteId, siteId),
        gt(schema.uptimeChecks.checkedAt, from),
        lte(schema.uptimeChecks.checkedAt, to),
      ));

  const [[current], [previous], [latest], series] = await Promise.all([
    scoped(windowStart, now),
    scoped(previousStart, windowStart),
    db
      .select({ checkedAt: schema.uptimeChecks.checkedAt, ok: schema.uptimeChecks.ok })
      .from(schema.uptimeChecks)
      .innerJoin(schema.monitors, eq(schema.monitors.id, schema.uptimeChecks.monitorId))
      .where(and(eq(schema.uptimeChecks.organisationId, organisationId), eq(schema.monitors.siteId, siteId)))
      .orderBy(desc(schema.uptimeChecks.checkedAt))
      .limit(1),
    // One row per day. Grouping in SQL rather than pulling ~180 rows back to
    // average them here, which is the same answer for a fraction of the wire.
    db
      .select({
        day: sql<string>`date_trunc('day', ${schema.uptimeChecks.checkedAt})::date::text`,
        latency: avg(schema.uptimeChecks.latencyMs),
      })
      .from(schema.uptimeChecks)
      .innerJoin(schema.monitors, eq(schema.monitors.id, schema.uptimeChecks.monitorId))
      .where(and(
        eq(schema.uptimeChecks.organisationId, organisationId),
        eq(schema.monitors.siteId, siteId),
        gt(schema.uptimeChecks.checkedAt, windowStart),
        isNotNull(schema.uptimeChecks.latencyMs),
      ))
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .limit(CHART_POINTS),
  ]);

  const total = current?.total ?? 0;
  const responseMs = current?.latency == null ? null : Math.round(Number(current.latency));
  const previousMs = previous?.latency == null ? null : Math.round(Number(previous.latency));

  return {
    percent: total === 0 ? null : Math.round(((current!.ok ?? 0) / total) * 10_000) / 100,
    responseMs,
    responseTrend:
      responseMs !== null && previousMs !== null ? changeOf(responseMs, previousMs, true) : null,
    lastCheckedAt: latest?.checkedAt ?? null,
    up: latest?.ok ?? null,
    responseSeries: series.map((row) => Math.round(Number(row.latency ?? 0))),
  };
}

/** The whole dashboard for one client. */
export async function clientDashboard(
  db: Db,
  organisationId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<ClientDashboard> {
  const windowStart = new Date(now.getTime() - DASHBOARD_WINDOW_DAYS * 86_400_000);
  const scope = and(eq(schema.tickets.organisationId, organisationId), eq(schema.tickets.clientId, clientId));

  const [siteRow] = await db
    .select({
      id: schema.sites.id, name: schema.sites.name, primaryUrl: schema.sites.primaryUrl, status: schema.sites.status,
    })
    .from(schema.sites)
    .where(and(
      eq(schema.sites.organisationId, organisationId),
      eq(schema.sites.clientId, clientId),
      isNull(schema.sites.deletedAt),
    ))
    .orderBy(desc(schema.sites.createdAt))
    .limit(1);

  const [
    screenshot, domainRow, planRow, taskRows, ticketOpen, ticketResolved,
    firstResponse, incidentRows, invoiceRow, contentCount, activity,
  ] = await Promise.all([
    siteRow
      ? db.select({ id: schema.siteScreenshots.id })
          .from(schema.siteScreenshots)
          .where(and(eq(schema.siteScreenshots.siteId, siteRow.id), isNotNull(schema.siteScreenshots.capturedAt)))
          .limit(1)
      : Promise.resolve([]),
    db.select({ name: schema.domains.name, expiresAt: schema.domains.expiresAt })
      .from(schema.domains)
      .where(and(
        eq(schema.domains.organisationId, organisationId),
        eq(schema.domains.clientId, clientId),
        isNull(schema.domains.deletedAt),
      ))
      .orderBy(desc(schema.domains.createdAt))
      .limit(1),
    db.select({
        amountPence: schema.subscriptions.amountPence,
        currency: schema.subscriptions.currency,
        status: schema.subscriptions.status,
        renewsAt: schema.subscriptions.currentPeriodEnd,
      })
      .from(schema.subscriptions)
      .where(and(
        eq(schema.subscriptions.organisationId, organisationId),
        eq(schema.subscriptions.clientId, clientId),
        isNull(schema.subscriptions.deletedAt),
      ))
      .orderBy(desc(schema.subscriptions.createdAt))
      .limit(1),
    db.select({ status: schema.tasks.status, completedAt: schema.tasks.completedAt })
      .from(schema.tasks)
      .where(and(
        eq(schema.tasks.organisationId, organisationId),
        eq(schema.tasks.clientId, clientId),
        eq(schema.tasks.clientVisible, true),
        isNull(schema.tasks.deletedAt),
      )),
    db.select({ n: count() }).from(schema.tickets)
      .where(and(scope, eq(schema.tickets.clientVisible, true), notInArray(schema.tickets.status, [...CLOSED_TICKETS]))),
    db.select({ n: count() }).from(schema.tickets)
      .where(and(scope, eq(schema.tickets.clientVisible, true), gte(schema.tickets.resolvedAt, windowStart))),
    db.select({
        hours: sql<number | null>`avg(extract(epoch from (${schema.tickets.firstResponseAt} - ${schema.tickets.createdAt})) / 3600)`,
      })
      .from(schema.tickets)
      .where(and(scope, isNotNull(schema.tickets.firstResponseAt), gte(schema.tickets.createdAt, windowStart))),
    siteRow
      ? db.select({ status: schema.incidents.status })
          .from(schema.incidents)
          .where(and(
            eq(schema.incidents.organisationId, organisationId),
            eq(schema.incidents.siteId, siteRow.id),
            gte(schema.incidents.openedAt, windowStart),
          ))
      : Promise.resolve([]),
    db.select({
        pence: sql<number>`coalesce(sum(${schema.invoices.totalPence}), 0)::int`,
        n: count(),
      })
      .from(schema.invoices)
      .where(and(
        eq(schema.invoices.organisationId, organisationId),
        eq(schema.invoices.clientId, clientId),
        notInArray(schema.invoices.status, ["paid", "void", "draft"]),
        isNull(schema.invoices.deletedAt),
      )),
    db.select({ n: count() }).from(schema.contentItems)
      .where(and(
        eq(schema.contentItems.organisationId, organisationId),
        eq(schema.contentItems.clientId, clientId),
        eq(schema.contentItems.status, "published"),
        gte(schema.contentItems.publishedAt, windowStart),
      )),
    db.select({
        id: schema.activityEvents.id, kind: schema.activityEvents.kind, title: schema.activityEvents.title,
        body: schema.activityEvents.body, link: schema.activityEvents.link, createdAt: schema.activityEvents.createdAt,
      })
      .from(schema.activityEvents)
      .where(and(
        eq(schema.activityEvents.organisationId, organisationId),
        eq(schema.activityEvents.clientId, clientId),
      ))
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(8),
  ]);

  const uptime = siteRow
    ? await uptimeFor(db, organisationId, siteRow.id, now)
    : { percent: null, responseMs: null, responseTrend: null, lastCheckedAt: null, up: null, responseSeries: [] };

  const hours = firstResponse[0]?.hours;

  return {
    site: siteRow
      ? { ...siteRow, hasScreenshot: screenshot.length > 0 }
      : null,
    uptime,
    domain: domainRow[0] ?? null,
    plan: planRow[0] ?? null,
    work: {
      inProgress: taskRows.filter((t) => t.status === "in_progress").length,
      waitingOnClient: taskRows.filter((t) => t.status === "blocked" || t.status === "review").length,
      doneThisWindow: taskRows.filter((t) => t.completedAt !== null && t.completedAt >= windowStart).length,
    },
    support: {
      open: ticketOpen[0]?.n ?? 0,
      resolvedThisWindow: ticketResolved[0]?.n ?? 0,
      firstResponseHours: hours == null ? null : Math.round(Number(hours) * 10) / 10,
    },
    incidents: {
      opened: incidentRows.length,
      resolved: incidentRows.filter((i) => i.status === "resolved").length,
    },
    invoices: {
      outstandingPence: invoiceRow[0]?.pence ?? 0,
      outstandingCount: invoiceRow[0]?.n ?? 0,
    },
    contentPublishedThisWindow: contentCount[0]?.n ?? 0,
    activity,
  };
}

/** Live tasks, exported so the portal's own task list and this agree on the word. */
export const DASHBOARD_LIVE_TASK_STATUSES = LIVE_TASKS;
