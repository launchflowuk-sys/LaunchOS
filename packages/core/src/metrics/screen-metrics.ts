import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

/**
 * The headline figures each list screen leads with.
 *
 * One module rather than one per screen, because they are all the same shape —
 * a handful of counts and sums over rows we already hold — and splitting them
 * would mean five files that each import the same three tables. Each function
 * takes `(db, organisationId)` like everything else in `core`, and every one of
 * them filters on the organisation.
 *
 * Nothing here invents a number. Where the UI brief asks for a figure with no
 * source behind it — client satisfaction, cost per lead without ad spend joined
 * to a lead — it is absent rather than approximated, because a number on a
 * dashboard is eventually quoted at somebody.
 */

const IN_FLIGHT_PROJECTS = ["planned", "active", "on_hold"] as const;
const DAY_MS = 86_400_000;

export interface ProjectMetrics {
  readonly inFlight: number;
  readonly dueThisMonth: number;
  /** Past its target date and not delivered. The one that needs a person. */
  readonly overdue: number;
  readonly deliveredThisMonth: number;
}

export async function projectMetrics(db: Db, organisationId: string, now: Date = new Date()): Promise<ProjectMetrics> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const today = now.toISOString().slice(0, 10);
  const org = eq(schema.projects.organisationId, organisationId);

  const [inFlight, dueThisMonth, overdue, delivered] = await Promise.all([
    db.select({ v: count() }).from(schema.projects)
      .where(and(org, inArray(schema.projects.status, [...IN_FLIGHT_PROJECTS]))),
    db.select({ v: count() }).from(schema.projects)
      .where(and(org, inArray(schema.projects.status, [...IN_FLIGHT_PROJECTS]),
        sql`${schema.projects.targetDate} >= ${monthStart.toISOString().slice(0, 10)}`,
        sql`${schema.projects.targetDate} < ${monthEnd.toISOString().slice(0, 10)}`)),
    // A target date is a date, not an instant — "the end of March" is what was
    // promised — so this compares dates and not timestamps.
    db.select({ v: count() }).from(schema.projects)
      .where(and(org, inArray(schema.projects.status, [...IN_FLIGHT_PROJECTS]),
        sql`${schema.projects.targetDate} < ${today}`)),
    db.select({ v: count() }).from(schema.projects)
      .where(and(org, isNotNull(schema.projects.deliveredAt), gte(schema.projects.deliveredAt, monthStart))),
  ]);

  return {
    inFlight: inFlight[0]?.v ?? 0,
    dueThisMonth: dueThisMonth[0]?.v ?? 0,
    overdue: overdue[0]?.v ?? 0,
    deliveredThisMonth: delivered[0]?.v ?? 0,
  };
}

export interface LeadMetrics {
  readonly newLeads: number;
  readonly qualified: number;
  readonly convertedThisMonth: number;
  /** Still `new` after 24 hours — nobody has written back. */
  readonly awaitingReply: number;
}

export async function leadMetrics(db: Db, organisationId: string, now: Date = new Date()): Promise<LeadMetrics> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const org = eq(schema.leads.organisationId, organisationId);
  const alive = sql`${schema.leads.deletedAt} is null`;

  const [fresh, qualified, converted, waiting] = await Promise.all([
    db.select({ v: count() }).from(schema.leads).where(and(org, alive, eq(schema.leads.status, "new"))),
    db.select({ v: count() }).from(schema.leads).where(and(org, alive, eq(schema.leads.status, "qualified"))),
    db.select({ v: count() }).from(schema.leads)
      .where(and(org, alive, eq(schema.leads.status, "converted"), gte(schema.leads.updatedAt, monthStart))),
    db.select({ v: count() }).from(schema.leads)
      .where(and(org, alive, eq(schema.leads.status, "new"),
        lte(schema.leads.createdAt, new Date(now.getTime() - DAY_MS)))),
  ]);

  return {
    newLeads: fresh[0]?.v ?? 0,
    qualified: qualified[0]?.v ?? 0,
    convertedThisMonth: converted[0]?.v ?? 0,
    awaitingReply: waiting[0]?.v ?? 0,
  };
}

export interface WebsiteMetrics {
  readonly live: number;
  readonly building: number;
  readonly withOpenIncident: number;
  readonly launchedThisMonth: number;
}

export async function websiteMetrics(db: Db, organisationId: string, now: Date = new Date()): Promise<WebsiteMetrics> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const org = eq(schema.sites.organisationId, organisationId);

  const [live, building, incidents, launched] = await Promise.all([
    db.select({ v: count() }).from(schema.sites).where(and(org, eq(schema.sites.status, "live"))),
    db.select({ v: count() }).from(schema.sites).where(and(org, eq(schema.sites.status, "building"))),
    // Distinct sites, not incidents: three incidents on one site is one site
    // that needs looking at, and counting them as three overstates the problem.
    db.select({ v: sql<number>`count(distinct ${schema.incidents.siteId})::int` })
      .from(schema.incidents)
      .where(and(eq(schema.incidents.organisationId, organisationId),
        inArray(schema.incidents.status, ["open", "acknowledged"]))),
    db.select({ v: count() }).from(schema.sites).where(and(org, gte(schema.sites.createdAt, monthStart))),
  ]);

  return {
    live: live[0]?.v ?? 0,
    building: building[0]?.v ?? 0,
    withOpenIncident: Number(incidents[0]?.v ?? 0),
    launchedThisMonth: launched[0]?.v ?? 0,
  };
}

export interface DomainMetrics {
  readonly active: number;
  /** Renewing inside 30 days. The number this screen exists for. */
  readonly expiringSoon: number;
  readonly expired: number;
  readonly autoRenewOff: number;
}

export async function domainMetrics(db: Db, organisationId: string, now: Date = new Date()): Promise<DomainMetrics> {
  const org = eq(schema.domains.organisationId, organisationId);
  const in30 = new Date(now.getTime() + 30 * DAY_MS);

  const [active, expiring, expired, manual] = await Promise.all([
    db.select({ v: count() }).from(schema.domains).where(and(org, eq(schema.domains.status, "active"))),
    db.select({ v: count() }).from(schema.domains)
      .where(and(org, isNotNull(schema.domains.expiresAt),
        gte(schema.domains.expiresAt, now), lte(schema.domains.expiresAt, in30))),
    db.select({ v: count() }).from(schema.domains)
      .where(and(org, isNotNull(schema.domains.expiresAt), lte(schema.domains.expiresAt, now))),
    // Auto-renew off *and* expiring is the combination that loses a domain, so
    // it is counted rather than left to be noticed.
    db.select({ v: count() }).from(schema.domains)
      .where(and(org, eq(schema.domains.autoRenew, false), isNotNull(schema.domains.expiresAt),
        lte(schema.domains.expiresAt, in30))),
  ]);

  return {
    active: active[0]?.v ?? 0,
    expiringSoon: expiring[0]?.v ?? 0,
    expired: expired[0]?.v ?? 0,
    autoRenewOff: manual[0]?.v ?? 0,
  };
}

export interface CaseStudyMetrics {
  readonly published: number;
  readonly drafts: number;
  readonly featured: number;
  /** Delivered projects with no case study — the backlog of proof not yet written. */
  readonly eligible: number;
}

export async function caseStudyMetrics(db: Db, organisationId: string): Promise<CaseStudyMetrics> {
  const org = eq(schema.caseStudies.organisationId, organisationId);

  const [published, drafts, featured, eligible] = await Promise.all([
    db.select({ v: count() }).from(schema.caseStudies).where(and(org, eq(schema.caseStudies.status, "published"))),
    db.select({ v: count() }).from(schema.caseStudies).where(and(org, eq(schema.caseStudies.status, "draft"))),
    db.select({ v: count() }).from(schema.caseStudies).where(and(org, eq(schema.caseStudies.featured, true))),
    db.select({ v: sql<number>`count(*)::int` })
      .from(schema.projects)
      .where(and(eq(schema.projects.organisationId, organisationId), isNotNull(schema.projects.deliveredAt))),
  ]);

  return {
    published: published[0]?.v ?? 0,
    drafts: drafts[0]?.v ?? 0,
    featured: featured[0]?.v ?? 0,
    eligible: Number(eligible[0]?.v ?? 0),
  };
}

export interface InvoiceMetrics {
  readonly overduePence: number;
  readonly outstandingPence: number;
  readonly paidThisMonthPence: number;
  readonly overdueCount: number;
}

export async function invoiceMetrics(db: Db, organisationId: string, now: Date = new Date()): Promise<InvoiceMetrics> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const org = eq(schema.invoices.organisationId, organisationId);
  const pence = sql<string>`coalesce(sum(${schema.invoices.totalPence}), 0)`;

  const [overdue, outstanding, paid] = await Promise.all([
    db.select({ pence, v: count() }).from(schema.invoices).where(and(org, eq(schema.invoices.status, "overdue"))),
    // Sent but not settled. Draft is not money owed yet, and void never was.
    db.select({ pence }).from(schema.invoices).where(and(org, inArray(schema.invoices.status, ["sent", "overdue"]))),
    db.select({ pence }).from(schema.invoices)
      .where(and(org, eq(schema.invoices.status, "paid"), isNotNull(schema.invoices.paidAt),
        gte(schema.invoices.paidAt, monthStart))),
  ]);

  return {
    overduePence: Number(overdue[0]?.pence ?? 0),
    outstandingPence: Number(outstanding[0]?.pence ?? 0),
    paidThisMonthPence: Number(paid[0]?.pence ?? 0),
    overdueCount: overdue[0]?.v ?? 0,
  };
}
