import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentKind, PackageIncludes } from "@launchos/db/schema";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { londonAt, parsePeriodKey } from "../content/schedule.js";
import { periodKeyFor } from "../content/shared.js";

/**
 * How much of the package a client pays for they have actually used this
 * month, and who is at or past the edge of it.
 *
 * This exists for one line in the morning Ops Brief and for nothing else.
 * **Nothing here contacts anybody.** A client using everything they buy is a
 * conversation Shoji has, in his own words, when he judges the moment is
 * right — an automatic "you have used 4 of your 4 posts, would you like to
 * upgrade?" email would read as a meter running, which is the opposite of how
 * a small business wants to be treated by the person who looks after their
 * website. So this collector produces figures, the brief reports them, and a
 * person decides.
 *
 * Entitlement comes from the *active subscription's* package, never from
 * `clients.package_id` — what they are paying for this month is what they get,
 * the same rule `planContentMonth` plans a month by. A client with no active
 * subscription, or one whose subscription carries no package, is left out
 * entirely: they are not near a limit, because they have no limit to be near.
 * That is a different conversation and not this one.
 */

/** Subscription statuses that still mean "they are paying us" — the same set `activeSubscriptionForClient` uses. */
const PAYING_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

/**
 * The share of a monthly allowance at which the brief starts mentioning it.
 *
 * Three quarters, because the number that matters to Shoji is not a
 * percentage but "how many are left". The allowances he actually sells are
 * small — 1 blog post, 2 GBP updates, 4 or 8 social posts — and at three
 * quarters every one of those sizes leaves at least one item still to come:
 * 3 of 4 posts trips it with one left, 6 of 8 with two left. Four fifths would
 * only trip 4 of 4 — the month already spent — which is a report, not a
 * warning. Below three quarters (a half, say) a client who simply started
 * early would be flagged in the first week of every month, and a line that
 * appears every morning stops being read.
 *
 * At an allowance of 1 or 2 the maths degenerates to "fully used", which is
 * honest: there was never any earlier point to warn at.
 */
export const PACKAGE_ALLOWANCE_NEAR_RATIO = 0.75;

/** How many clients the collector returns by default. Shoji has fewer than this; the cap is a payload guard, not a policy. */
const DEFAULT_PRESSURE_LIMIT = 50;

/** Past at least one allowance, or close to one but past none. Two different signals, and they read differently in the brief. */
export type PackageStanding = "over" | "near";

/** One line of a client's month: what the package includes, and what they used. */
export interface PackageAllowanceUsage {
  /** How it reads in a sentence — "Social posts", "Ads support (not in the package)". */
  label: string;
  used: number;
  /** What the package includes each month. `0` means the package does not cover this work at all, so any use of it is over. */
  allowed: number;
  /** `used` as a whole-number percentage of `allowed`. Null when `allowed` is 0 — there is nothing to be a percentage of. */
  usedPercent: number | null;
}

/** One client who is at or past the edge of what they pay for. */
export interface ClientPackagePressure {
  clientId: string;
  clientName: string;
  packageName: string;
  /** The Europe/London month measured, `YYYY-MM`. Always a calendar month: a package is sold by the month, not by the brief's 24-hour window. */
  periodKey: string;
  standing: PackageStanding;
  /** Only the allowances under pressure, worst first. One nobody is near is left out. */
  allowances: PackageAllowanceUsage[];
}

export const PackageUsagePressureInput = z.object({
  now: z.coerce.date().default(() => new Date()),
  limit: z.number().int().min(1).max(200).default(DEFAULT_PRESSURE_LIMIT),
});
export type PackageUsagePressureInput = z.input<typeof PackageUsagePressureInput>;

/** The quantity allowances a package sells, and the content kind each one is spent on. Social covers Facebook and Instagram together, exactly as `slotsFor` plans them. */
const CONTENT_ALLOWANCES: readonly { label: string; kind: ContentKind; allowed: (includes: PackageIncludes) => number }[] = [
  { label: "Social posts", kind: "social_post", allowed: (includes) => includes.socialPostsPerMonth },
  { label: "Blog posts", kind: "blog_post", allowed: (includes) => includes.blogPostsPerMonth },
  { label: "Google Business updates", kind: "gbp_update", allowed: (includes) => includes.gbpUpdatesPerMonth },
];

type TicketCategory = (typeof schema.ticketCategoryEnum.enumValues)[number];

/**
 * Which part of the package covers a case category, for the categories a
 * package can be said to cover at all.
 *
 * A category missing from this table — `email`, `billing`, `other`, and an
 * uncategorised case — is part of being a client of LaunchFlow at all and is
 * never counted against anybody's package. `includes.seo` appears nowhere
 * because no case category maps to it: SEO is work we do, not a thing clients
 * raise cases about.
 *
 * Work the package does not cover is not a limit being approached, it is a
 * limit that was never bought, so it is reported as an allowance of 0 — any
 * use of it puts the client over. Three ads questions from a client on a
 * package with no ads in it is the clearest upsell tell there is.
 */
const CATEGORY_COVER: Partial<Record<TicketCategory, { label: string; covered: (includes: PackageIncludes) => boolean }>> = {
  hosting: { label: "Hosting support (not in the package)", covered: (includes) => includes.website },
  dns: { label: "DNS support (not in the package)", covered: (includes) => includes.website },
  content: {
    label: "Content support (not in the package)",
    covered: (includes) => includes.socialPostsPerMonth + includes.blogPostsPerMonth + includes.gbpUpdatesPerMonth > 0,
  },
  ads: { label: "Ads support (not in the package)", covered: (includes) => includes.ads },
};

interface PayingClient {
  clientId: string;
  clientName: string;
  packageName: string;
  includes: PackageIncludes;
}

/** Clients on a live subscription that names a package, earliest subscription first so one client resolves to one package. */
async function payingClients(db: Db, organisationId: string): Promise<PayingClient[]> {
  const rows = await db
    .select({
      clientId: schema.clients.id,
      clientName: schema.clients.name,
      packageName: schema.packages.name,
      includes: schema.packages.includes,
    })
    .from(schema.subscriptions)
    .innerJoin(
      schema.clients,
      and(eq(schema.clients.id, schema.subscriptions.clientId), eq(schema.clients.organisationId, organisationId)),
    )
    .innerJoin(
      schema.packages,
      and(eq(schema.packages.id, schema.subscriptions.packageId), eq(schema.packages.organisationId, organisationId)),
    )
    .where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      inArray(schema.subscriptions.status, [...PAYING_SUBSCRIPTION_STATUSES]),
      isNull(schema.subscriptions.deletedAt),
      isNull(schema.clients.deletedAt),
      // A paused or archived client is not somebody to sell a bigger package
      // to; whatever is going on with them, it is not an upsell.
      eq(schema.clients.status, "active"),
    ))
    .orderBy(asc(schema.subscriptions.createdAt), asc(schema.subscriptions.id));

  const byClient = new Map<string, PayingClient>();
  for (const row of rows) if (!byClient.has(row.clientId)) byClient.set(row.clientId, row);
  return [...byClient.values()];
}

/** Published items this month, keyed `<clientId>:<kind>`. Counted the same way as the snapshot's own content figures: published is published. */
async function publishedThisMonth(db: Db, organisationId: string, periodKey: string): Promise<Map<string, number>> {
  const item = schema.contentItems;
  const rows = await db
    .select({ clientId: item.clientId, kind: item.kind, used: sql<number>`count(*)::int` })
    .from(item)
    .where(and(eq(item.organisationId, organisationId), eq(item.periodKey, periodKey), isNotNull(item.publishedAt)))
    .groupBy(item.clientId, item.kind);
  return new Map(rows.map((row) => [`${row.clientId}:${row.kind}`, row.used]));
}

/** Cases opened inside the London month, keyed `<clientId>:<category>`. */
async function casesThisMonth(db: Db, organisationId: string, from: Date, to: Date): Promise<Map<string, number>> {
  const ticket = schema.tickets;
  const rows = await db
    .select({ clientId: ticket.clientId, category: ticket.category, used: sql<number>`count(*)::int` })
    .from(ticket)
    .where(and(
      eq(ticket.organisationId, organisationId),
      isNotNull(ticket.category),
      gte(ticket.createdAt, from),
      lt(ticket.createdAt, to),
    ))
    .groupBy(ticket.clientId, ticket.category);
  return new Map(rows.map((row) => [`${row.clientId}:${row.category}`, row.used]));
}

/** Where one allowance sits: over it, near it, or nowhere near it. */
function standingOf(used: number, allowed: number): PackageStanding | null {
  if (allowed === 0) return used > 0 ? "over" : null;
  if (used > allowed) return "over";
  return used >= allowed * PACKAGE_ALLOWANCE_NEAR_RATIO && used > 0 ? "near" : null;
}

/** How hard an allowance is pressing, for ordering only. An allowance of 0 that has been used sorts above a full one. */
function pressureOf(usage: PackageAllowanceUsage): number {
  return usage.allowed === 0 ? 1 + usage.used : usage.used / usage.allowed;
}

function allowancesFor(
  client: PayingClient,
  published: Map<string, number>,
  cases: Map<string, number>,
): PackageAllowanceUsage[] {
  const measured: { usage: PackageAllowanceUsage; standing: PackageStanding }[] = [];

  for (const allowance of CONTENT_ALLOWANCES) {
    const used = published.get(`${client.clientId}:${allowance.kind}`) ?? 0;
    const allowed = allowance.allowed(client.includes);
    const standing = standingOf(used, allowed);
    if (standing === null) continue;
    measured.push({
      standing,
      usage: {
        label: allowance.label,
        used,
        allowed,
        usedPercent: allowed === 0 ? null : Math.round((used / allowed) * 100),
      },
    });
  }

  for (const [category, cover] of Object.entries(CATEGORY_COVER) as [TicketCategory, NonNullable<(typeof CATEGORY_COVER)[TicketCategory]>][]) {
    if (cover.covered(client.includes)) continue;
    const used = cases.get(`${client.clientId}:${category}`) ?? 0;
    if (used === 0) continue;
    measured.push({ standing: "over", usage: { label: cover.label, used, allowed: 0, usedPercent: null } });
  }

  return measured
    .sort((a, b) => {
      if (a.standing !== b.standing) return a.standing === "over" ? -1 : 1;
      return pressureOf(b.usage) - pressureOf(a.usage);
    })
    .map((entry) => entry.usage);
}

/**
 * Every client at or past the edge of the package they pay for this month,
 * over-the-limit first and hardest-pressed first inside each group.
 *
 * The window is the calendar month in Europe/London containing `now`, not the
 * brief's 24-hour window: an allowance is monthly, so a day's slice of it
 * would mean nothing. Read-only — this writes nothing and sends nothing.
 */
export async function packageUsagePressure(
  db: Db,
  organisationId: string,
  input: PackageUsagePressureInput = {},
): Promise<ClientPackagePressure[]> {
  const v = PackageUsagePressureInput.parse(input);
  const periodKey = periodKeyFor(v.now);
  const [year, month] = parsePeriodKey(periodKey);
  const monthStart = londonAt(year, month, 1, 0);
  const monthEnd = month === 12 ? londonAt(year + 1, 1, 1, 0) : londonAt(year, month + 1, 1, 0);

  const clients = await payingClients(db, organisationId);
  if (clients.length === 0) return [];

  const [published, cases] = await Promise.all([
    publishedThisMonth(db, organisationId, periodKey),
    casesThisMonth(db, organisationId, monthStart, monthEnd),
  ]);

  const pressured = clients.flatMap((client): ClientPackagePressure[] => {
    const allowances = allowancesFor(client, published, cases);
    if (allowances.length === 0) return [];
    return [{
      clientId: client.clientId,
      clientName: client.clientName,
      packageName: client.packageName,
      periodKey,
      standing: allowances.some((a) => standingOf(a.used, a.allowed) === "over") ? "over" : "near",
      allowances,
    }];
  });

  return pressured
    .sort((a, b) => {
      if (a.standing !== b.standing) return a.standing === "over" ? -1 : 1;
      const worst = pressureOf(b.allowances[0]!) - pressureOf(a.allowances[0]!);
      return worst !== 0 ? worst : a.clientName.localeCompare(b.clientName, "en-GB");
    })
    .slice(0, v.limit);
}
