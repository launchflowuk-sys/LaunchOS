import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { counter, daysAgo, DEMO_PREFIX, DEMO_SLUG_PREFIX } from "./shared.js";

/**
 * Six months of one client's life, so the portal can be looked at rather than
 * imagined.
 *
 * The other three demo records exist to show a *prospect* the pipeline. This
 * one exists to show *us* the client portal with something on it. Every panel
 * on a client's dashboard reads from a different table, and a client with a
 * week of history leaves most of them empty — which is exactly the state in
 * which UI work goes wrong, because an empty panel hides every question worth
 * answering about density, overflow and hierarchy.
 *
 * So this writes half a year: a site checked six times a day, two outages it
 * recovered from, monthly invoices with one still owing, a dozen support
 * cases in every status, tasks finished and running, content published each
 * month, and the monthly reports that went with it.
 *
 * **It is a separate client on purpose.** Seeding this onto a real client
 * would put invented invoices in their billing, invented cases in their
 * history and invented work in the report they get sent. A demo client is
 * removed by one command and owes nobody an explanation.
 *
 * Uses the same `DEMO_` prefixes as its siblings, so `removeDemoClients`
 * takes it away with the rest.
 */

const NAME = `${DEMO_PREFIX}Northgate Blinds`;
const SLUG = `${DEMO_SLUG_PREFIX}northgate-blinds`;
const SITE_URL = "https://northgateblinds.example";

/** How long a history to write. Six months is two quarters of reports and enough chart to have a shape. */
const DAYS = 182;

/** Checks per day. Six is a readable chart over six months without a five-figure insert. */
const CHECKS_PER_DAY = 6;

/** The two outages, as days ago. Both recovered — an unresolved one would sit on the dashboard for ever. */
const OUTAGES = [
  { day: 96, minutes: 34, title: "Host unreachable", severity: "high" as const },
  { day: 23, minutes: 11, title: "Slow response from the web server", severity: "medium" as const },
];

/** Deterministic jitter, so two runs produce the same chart and a diff of the UI is a diff of the UI. */
function wobble(seed: number, spread: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * spread;
}

interface Ctx {
  db: Db;
  organisationId: string;
  clientId: string;
  siteId: string;
  now: Date;
  count: (key: string) => void;
}

/** The site, its monitor, and six months of checks with two outages in them. */
async function monitoring(ctx: Ctx): Promise<void> {
  const [monitor] = await ctx.db.insert(schema.monitors).values({
    organisationId: ctx.organisationId, siteId: ctx.siteId, kind: "http", target: SITE_URL, intervalSeconds: 300,
  }).returning();
  ctx.count("monitor");

  const checks: (typeof schema.uptimeChecks.$inferInsert)[] = [];
  for (let day = DAYS; day >= 0; day -= 1) {
    const outage = OUTAGES.find((o) => o.day === day);
    for (let slot = 0; slot < CHECKS_PER_DAY; slot += 1) {
      const checkedAt = new Date(daysAgo(day, ctx.now).getTime() + slot * (86_400_000 / CHECKS_PER_DAY));
      // One slot of the outage day fails; the rest of that day is the recovery.
      const failed = outage !== undefined && slot === 2;
      checks.push({
        organisationId: ctx.organisationId,
        monitorId: monitor!.id,
        checkedAt,
        ok: !failed,
        statusCode: failed ? 503 : 200,
        // A slow drift down over the six months, so the chart tells a story:
        // the site got faster, which is a thing we did.
        latencyMs: failed ? null : Math.round(620 - (DAYS - day) * 0.7 + wobble(day * 10 + slot, 90)),
        ...(failed ? { error: "connect ETIMEDOUT" } : {}),
      });
    }
  }
  await ctx.db.insert(schema.uptimeChecks).values(checks);
  ctx.count(`uptime checks (${checks.length})`);

  for (const outage of OUTAGES) {
    const openedAt = daysAgo(outage.day, ctx.now);
    await ctx.db.insert(schema.incidents).values({
      organisationId: ctx.organisationId, siteId: ctx.siteId, monitorId: monitor!.id,
      status: "resolved", severity: outage.severity, title: outage.title,
      summaryMd: `Detected automatically and cleared after ${outage.minutes} minutes. No action was needed from the client.`,
      openedAt, resolvedAt: new Date(openedAt.getTime() + outage.minutes * 60_000),
    });
    ctx.count("incident");
  }
}

/** A dozen cases across the six months, in every status a client can see. */
const CASES: readonly {
  day: number; subject: string; category: "hosting" | "dns" | "content" | "email" | "billing" | "other";
  severity: "low" | "medium" | "high" | "critical"; status: "open" | "in_progress" | "waiting_client" | "resolved";
  reply: string; resolvedAfterHours?: number;
}[] = [
  { day: 171, subject: "Can we add a photo gallery to the shutters page?", category: "content", severity: "low", status: "resolved", reply: "Added — twelve photos, laid out two across on a phone.", resolvedAfterHours: 27 },
  { day: 154, subject: "Contact form emails going to spam", category: "email", severity: "high", status: "resolved", reply: "Fixed. Your domain was missing a DMARC record; it is in place and I have tested from three providers.", resolvedAfterHours: 4 },
  { day: 132, subject: "Please change the opening hours for August", category: "content", severity: "low", status: "resolved", reply: "Updated on the site and on your Google listing.", resolvedAfterHours: 19 },
  { day: 118, subject: "Site felt slow this morning", category: "hosting", severity: "medium", status: "resolved", reply: "Found it — an oversized banner image. Compressed it; the homepage is about a second quicker now.", resolvedAfterHours: 6 },
  { day: 96, subject: "Is the site down?", category: "hosting", severity: "critical", status: "resolved", reply: "It was, for 34 minutes, and it is back. Our monitoring caught it before this came in.", resolvedAfterHours: 1 },
  { day: 77, subject: "New price list for the conservatory blinds", category: "content", severity: "low", status: "resolved", reply: "Live. I have kept the old one as a draft in case you want to roll back.", resolvedAfterHours: 31 },
  { day: 61, subject: "Can customers book a home visit online?", category: "other", severity: "low", status: "resolved", reply: "Yes — I have put a booking form on the contact page and it emails you and the customer.", resolvedAfterHours: 44 },
  { day: 44, subject: "Invoice query — what is the March line?", category: "billing", severity: "low", status: "resolved", reply: "That is the annual domain renewal. It is once a year, not monthly.", resolvedAfterHours: 3 },
  { day: 29, subject: "Add the new showroom address", category: "content", severity: "medium", status: "resolved", reply: "Done, and updated on your Google listing so the map is right.", resolvedAfterHours: 12 },
  { day: 16, subject: "Can we get the logo in a bigger size?", category: "other", severity: "low", status: "resolved", reply: "Sent over — SVG plus a 2000px PNG.", resolvedAfterHours: 2 },
  { day: 8, subject: "Christmas closing dates on the homepage", category: "content", severity: "low", status: "waiting_client", reply: "Happy to put this up — can you confirm the exact dates you are closed?" },
  { day: 2, subject: "Quote request form is missing the phone field", category: "content", severity: "medium", status: "in_progress", reply: "Looking at it now — I can see the field is not rendering on mobile. Will have it back today." },
];

/** Each case as a conversation, two messages and a ticket. */
async function support(ctx: Ctx): Promise<void> {
  for (const c of CASES) {
    const createdAt = daysAgo(c.day, ctx.now);
    const repliedAt = new Date(createdAt.getTime() + 2 * 3_600_000);
    const resolvedAt = c.resolvedAfterHours === undefined
      ? null
      : new Date(createdAt.getTime() + c.resolvedAfterHours * 3_600_000);

    const [conversation] = await ctx.db.insert(schema.conversations).values({
      organisationId: ctx.organisationId, clientId: ctx.clientId, siteId: ctx.siteId,
      subject: c.subject, channel: "portal",
      status: resolvedAt ? "closed" : "open",
      lastMessageAt: resolvedAt ?? repliedAt, createdAt,
    }).returning();

    await ctx.db.insert(schema.messages).values([
      {
        organisationId: ctx.organisationId, conversationId: conversation!.id,
        direction: "inbound", authorKind: "client", body: c.subject, createdAt,
      },
      {
        organisationId: ctx.organisationId, conversationId: conversation!.id,
        direction: "outbound", authorKind: "user", body: c.reply, createdAt: repliedAt, deliveredAt: repliedAt,
      },
    ]);

    await ctx.db.insert(schema.tickets).values({
      organisationId: ctx.organisationId, clientId: ctx.clientId, siteId: ctx.siteId,
      conversationId: conversation!.id, subject: c.subject, category: c.category,
      severity: c.severity, status: c.status, source: "portal",
      // The whole point of this record: a client has to be able to see them.
      clientVisible: true,
      firstResponseAt: repliedAt, createdAt,
      ...(resolvedAt ? { resolvedAt } : {}),
    });
    ctx.count("support case");
  }
}

/** What we did each month, as the client's task list. */
const WORK: readonly { day: number; title: string; kind: "content" | "seo" | "social" | "review" | "support" | "build" }[] = [
  { day: 168, title: "Monthly backup check and restore test", kind: "review" },
  { day: 165, title: "Shutters page rebuilt with the new photography", kind: "content" },
  { day: 150, title: "Google Business Profile updated for summer hours", kind: "seo" },
  { day: 138, title: "Monthly backup check and restore test", kind: "review" },
  { day: 131, title: "Page speed pass — images compressed sitewide", kind: "build" },
  { day: 120, title: "Two new customer reviews added to the homepage", kind: "content" },
  { day: 108, title: "Monthly backup check and restore test", kind: "review" },
  { day: 99, title: "WordPress core and plugins updated", kind: "build" },
  { day: 84, title: "Conservatory blinds price list published", kind: "content" },
  { day: 78, title: "Monthly backup check and restore test", kind: "review" },
  { day: 66, title: "Home visit booking form built and tested", kind: "build" },
  { day: 55, title: "Local SEO pass — service area pages reviewed", kind: "seo" },
  { day: 48, title: "Monthly backup check and restore test", kind: "review" },
  { day: 34, title: "Showroom address updated everywhere", kind: "content" },
  { day: 27, title: "Autumn campaign images prepared", kind: "social" },
  { day: 18, title: "Monthly backup check and restore test", kind: "review" },
  { day: 11, title: "Core Web Vitals improvements", kind: "build" },
  { day: 4, title: "Christmas opening hours — awaiting your dates", kind: "content" },
  { day: -3, title: "Quote form mobile fix", kind: "support" },
  { day: -9, title: "December content plan", kind: "content" },
];

async function work(ctx: Ctx): Promise<void> {
  for (const w of WORK) {
    const createdAt = daysAgo(w.day + 3, ctx.now);
    // Anything dated in the future is still running; everything behind us is done.
    const done = w.day > 0;
    await ctx.db.insert(schema.tasks).values({
      organisationId: ctx.organisationId, clientId: ctx.clientId, siteId: ctx.siteId,
      phase: w.kind === "support" ? "support" : "recurring", kind: w.kind, title: w.title,
      status: done ? "done" : w.day > -5 ? "in_progress" : "todo",
      priority: "medium", clientVisible: true,
      dueAt: daysAgo(w.day, ctx.now), createdAt,
      ...(done ? { completedAt: daysAgo(w.day, ctx.now) } : {}),
    });
    ctx.count("task");
  }
}

/** Money: a live retainer, six invoices, one of them still owing. */
async function billing(ctx: Ctx): Promise<void> {
  const [subscription] = await ctx.db.insert(schema.subscriptions).values({
    organisationId: ctx.organisationId, clientId: ctx.clientId, status: "active",
    currentPeriodStart: daysAgo(12, ctx.now), currentPeriodEnd: daysAgo(-18, ctx.now),
    amountPence: 11000, currency: "GBP",
  }).returning();
  ctx.count("subscription");

  for (let month = 5; month >= 0; month -= 1) {
    const issuedAt = daysAgo(month * 30 + 12, ctx.now);
    const unpaid = month === 0;
    await ctx.db.insert(schema.invoices).values({
      organisationId: ctx.organisationId, clientId: ctx.clientId, subscriptionId: subscription!.id,
      number: `DEMO-${String(2600 + month).padStart(4, "0")}`,
      status: unpaid ? "sent" : "paid",
      issuedAt, dueAt: new Date(issuedAt.getTime() + 14 * 86_400_000),
      ...(unpaid ? {} : { paidAt: new Date(issuedAt.getTime() + 3 * 86_400_000) }),
      subtotalPence: 11000, vatPence: 0, totalPence: 11000, currency: "GBP", createdAt: issuedAt,
    });
    ctx.count("invoice");
  }
}

/** The monthly report that went out with each invoice. */
async function reports(ctx: Ctx): Promise<void> {
  for (let month = 5; month >= 1; month -= 1) {
    const start = daysAgo(month * 30 + 30, ctx.now);
    const end = daysAgo(month * 30, ctx.now);
    const publishedAt = daysAgo(month * 30 - 1, ctx.now);
    await ctx.db.insert(schema.clientReports).values({
      organisationId: ctx.organisationId, clientId: ctx.clientId,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
      summaryMd: "Everything stayed online this month. The work below went out as planned.",
      stats: {
        tasksDone: 3, tasksOpen: 1, uptimePercent: 99.97, ticketsOpened: 2, ticketsResolved: 2,
        ads: null, invoices: { issued: 1, paidPence: 11000, outstandingPence: 0 }, currency: "GBP",
      },
      status: "published", publishedAt, createdAt: start,
    });
    ctx.count("monthly report");
  }
}

export interface PortalShowcaseResult {
  clientId: string;
  siteId: string;
  created: Record<string, number>;
}

/** Writes the whole six months. Assumes `removeDemoClients` has already run. */
export async function seedPortalShowcase(
  db: Db,
  organisationId: string,
  now: Date = new Date(),
): Promise<PortalShowcaseResult> {
  const { created, count } = counter();

  const [client] = await db.insert(schema.clients).values({
    organisationId, name: NAME, slug: SLUG, email: "hello@northgateblinds.example",
    phone: "01375 555 0142", status: "active", createdAt: daysAgo(DAYS, now),
  }).returning();
  count("client");

  const [site] = await db.insert(schema.sites).values({
    organisationId, clientId: client!.id, name: "Northgate Blinds",
    slug: "demo-northgate-blinds", primaryUrl: SITE_URL, platform: "wordpress",
    status: "live", createdAt: daysAgo(DAYS, now),
  }).returning();
  count("site");

  await db.insert(schema.domains).values({
    organisationId, clientId: client!.id, siteId: site!.id, name: "northgateblinds.example",
    registrar: "Hostinger", dnsProvider: "cloudflare",
    expiresAt: daysAgo(-279, now), createdAt: daysAgo(DAYS, now),
  });
  count("domain");

  // No bytes: the screenshot worker takes the picture. The row exists so the
  // dashboard's thumbnail slot is exercised in its honest "not captured yet"
  // state rather than being absent entirely.
  await db.insert(schema.siteScreenshots).values({
    organisationId, siteId: site!.id, adapter: "demo", sizeBytes: 0, attemptedAt: now,
  });
  count("screenshot slot");

  const ctx: Ctx = { db, organisationId, clientId: client!.id, siteId: site!.id, now, count };
  await monitoring(ctx);
  await support(ctx);
  await work(ctx);
  await billing(ctx);
  await reports(ctx);

  return { clientId: client!.id, siteId: site!.id, created };
}
