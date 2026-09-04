/**
 * Development seed: one organisation, the owner account, two real clients with
 * a site and an uptime monitor each, the Hosting Guard-Dog and Ad Performance
 * Sentinel agents enabled, a portal login, and enough billing, ads and
 * reporting data for every screen to have something on it.
 *
 * Idempotent: every step looks the row up (by slug / email / name / target /
 * calendar month) before inserting, so `pnpm db:seed` can be run repeatedly.
 *
 * The owner password comes from SEED_OWNER_PASSWORD (default "change-me-now")
 * and the portal login's from SEED_CLIENT_PASSWORD (default the owner's).
 * Never commit a real password here. Under NODE_ENV=production the seed refuses
 * to run unless SEED_OWNER_PASSWORD is set, so the default can never reach a
 * live database.
 *
 * This file imports `@launchos/core` and `@launchos/integrations`, which are
 * dev dependencies of `packages/db`. The seed is a dev script, so this does not
 * invert the shipped `core → db` dependency direction.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  buildClientReport, createAdAccount, createInvoiceFromSubscription, createSubscription,
  ingestDailyMetrics, markInvoiceSent, monthPeriod, publishClientReport, recordPayment,
} from "@launchos/core";
import { MockAdsAdapter, MockPaymentsAdapter } from "@launchos/integrations";
import { hashPassword } from "better-auth/crypto";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { createDb } from "./client.js";
import * as schema from "./schema/index.js";

loadRootEnv();

const OWNER_EMAIL = "shujaat@nexusedu.co.uk";
const OWNER_NAME = "Shoji";
const ORGANISATION = { slug: "launchflow", name: "LaunchFlow" } as const;
const AGENT_KEY = "hosting-guard-dog";
const SENTINEL_AGENT_KEY = "ad-performance-sentinel";

const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "change-me-now";
const CLIENT_USER = {
  email: process.env.SEED_CLIENT_EMAIL ?? "portal@grayscabline.co.uk",
  name: "Grays CabLine portal",
  password: process.env.SEED_CLIENT_PASSWORD ?? OWNER_PASSWORD,
} as const;

const AD_ACCOUNT = { platform: "google" as const, externalId: "123-456-7890", name: "Grays CabLine — Search" };
const SNAPSHOT_DAYS = 30;
const ROAS_DROP_DAYS = 7;
const VAT_RATE_PERCENT = 20;

const isoDay = (value: Date) => value.toISOString().slice(0, 10);
// Better Auth namespaces credential accounts as "local:<providerId>"
// (createLocalAccountIssuer in @better-auth/core/db, not publicly exported).
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;

const SUPPORT_EMAIL_DOMAIN = process.env.SUPPORT_EMAIL_DOMAIN ?? "support.launchflow.co.uk";

const STAFF = { email: "team@launchflow.example", name: "Sam Staff", title: "Support" } as const;

const SEED_CLIENTS = [
  {
    name: "Grays CabLine",
    slug: "grays-cabline",
    email: "info@grayscabline.co.uk",
    url: "https://grayscabline.co.uk",
    contacts: [
      { name: "Shoji", email: "shujaat@nexusedu.co.uk", role: "Owner", isPrimary: true },
      { name: "Dispatch desk", email: "dispatch@grayscabline.co.uk", role: "Operations", isPrimary: false },
    ],
    // The second domain deliberately has no site: a domain can be bought first.
    domains: ["grayscabline.co.uk", "grayscabline.com"],
  },
  {
    name: "Mobile PC Doctor",
    slug: "mobile-pc-doctor",
    email: "info@mobilepcdoctor.co.uk",
    url: "https://mobilepcdoctor.co.uk",
    contacts: [
      { name: "Shoji", email: "shujaat@nexusedu.co.uk", role: "Owner", isPrimary: true },
      { name: "Workshop", email: "workshop@mobilepcdoctor.co.uk", role: "Repairs", isPrimary: false },
    ],
    domains: ["mobilepcdoctor.co.uk"],
  },
] as const;

const SEED_PACKAGES = [
  {
    slug: "website-care", name: "Website Care",
    description: "Hosting, maintenance and monthly content for a brochure site.",
    monthlyPricePence: 9900, setupPricePence: 49900,
    includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  },
  {
    slug: "website-seo-social", name: "Website + SEO + Social",
    description: "Everything in Website Care plus SEO and four social posts a month.",
    monthlyPricePence: 29900, setupPricePence: 79900,
    includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  },
] as const;

// Zero to handover, in the order Shoji actually works it. All global: every
// package starts the same way.
const ONBOARDING_TEMPLATES = [
  { title: "Discovery call", kind: "other", offsetDays: 1, sortOrder: 10, defaultAssigneeRole: "owner", checklist: ["Goals", "Competitors", "Deadline"] },
  { title: "Content collection", kind: "content", offsetDays: 3, sortOrder: 20, defaultAssigneeRole: "any", checklist: ["Logo", "Photos", "Copy", "Opening hours"] },
  { title: "Design approval", kind: "review", offsetDays: 7, sortOrder: 30, defaultAssigneeRole: "owner", checklist: [] },
  { title: "Build website", kind: "build", offsetDays: 14, sortOrder: 40, defaultAssigneeRole: "any", checklist: ["Home", "Services", "Contact form", "Mobile check"] },
  { title: "DNS and hosting setup", kind: "dns", offsetDays: 16, sortOrder: 50, defaultAssigneeRole: "owner", checklist: ["Nameservers", "SSL", "Coolify resource"] },
  { title: "Deploy to production", kind: "deploy", offsetDays: 18, sortOrder: 60, defaultAssigneeRole: "any", checklist: ["Deploy", "Uptime monitor", "Backups"] },
  { title: "SEO setup", kind: "seo", offsetDays: 20, sortOrder: 70, defaultAssigneeRole: "any", checklist: ["Titles and descriptions", "Sitemap", "Search Console"] },
  { title: "Google Business Profile setup", kind: "gbp", offsetDays: 21, sortOrder: 80, defaultAssigneeRole: "any", checklist: ["Claim listing", "Categories", "Photos"] },
  { title: "Review request", kind: "review", offsetDays: 25, sortOrder: 90, defaultAssigneeRole: "any", checklist: [] },
  { title: "Handover", kind: "handover", offsetDays: 28, sortOrder: 100, defaultAssigneeRole: "owner", checklist: ["Walkthrough call", "Logins handed over", "Support address shared"] },
] as const;

// Quantities come from the package's `includes`, not from these rows.
const RECURRING_TEMPLATES = [
  { title: "Social post", kind: "social", recurrence: "monthly", sortOrder: 10, packageSlug: "website-seo-social", checklist: ["Draft", "Image", "Schedule"] },
  { title: "Blog post", kind: "content", recurrence: "monthly", sortOrder: 20, packageSlug: null, checklist: ["Outline", "Draft", "Publish"] },
  { title: "Google Business Profile update", kind: "gbp", recurrence: "monthly", sortOrder: 30, packageSlug: null, checklist: [] },
  { title: "SEO audit", kind: "seo", recurrence: "quarterly", sortOrder: 40, packageSlug: "website-seo-social", checklist: ["Rankings", "Broken links", "Page speed"] },
] as const;

const CLIENT_PACKAGES: Record<string, string> = {
  "Grays CabLine": "website-seo-social",
  "Mobile PC Doctor": "website-care",
};

function loadRootEnv() {
  if (process.env.DATABASE_URL) return;
  for (const path of ["../../.env", "../.env", ".env"]) {
    try {
      process.loadEnvFile(resolve(process.cwd(), path));
      if (process.env.DATABASE_URL) return;
    } catch {
      // file absent — try the next candidate
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed");
  if (process.env.NODE_ENV === "production" && !process.env.SEED_OWNER_PASSWORD) {
    throw new Error(
      "SEED_OWNER_PASSWORD is required when NODE_ENV=production. " +
        "Refusing to seed the owner account with the default development password. " +
        "Set SEED_OWNER_PASSWORD in the resource environment, run the seed once, then remove it.",
    );
  }
  const db = createDb(url);

  try {
    const organisation = await seedOrganisation(db);
    const user = await seedOwner(db);
    const membership = await seedMembership(db, organisation.id, user.id);
    const enablement = await seedAgentEnablement(db, organisation.id, AGENT_KEY);
    const staff = await seedStaffMember(db, organisation.id);
    const packagesBySlug = await seedPackages(db, organisation.id);
    const templateCount = await seedTaskTemplates(db, organisation.id, packagesBySlug);

    console.log("organisation  ", organisation.id, organisation.slug);
    console.log("owner user    ", user.id, user.email);
    console.log("membership    ", membership.id, membership.role);
    console.log("staff member  ", staff.id, `${STAFF.email} ${staff.role}/${staff.status}`);
    console.log("agent         ", enablement.id, `${enablement.agentKey} enabled=${enablement.enabled}`);
    console.log("packages      ", [...packagesBySlug.keys()].join(", "));
    console.log("templates     ", `${templateCount} created`);

    const seededClients: { id: string; name: string; email: string }[] = [];
    for (const spec of SEED_CLIENTS) {
      const client = await seedClient(db, organisation.id, spec);
      seededClients.push({ id: client.id, name: client.name, email: client.email ?? spec.email });
      const site = await seedSite(db, organisation.id, client.id, spec);
      const monitor = await seedMonitor(db, organisation.id, site.id, spec.url);
      const billing = await seedBillingProfile(db, organisation.id, client.id, spec.name);
      await seedContacts(db, organisation.id, client.id, spec.contacts);
      await seedDomains(db, organisation.id, client.id, site.id, spec.domains);
      await seedActivity(db, organisation.id, client.id, spec.name, site.id);
      const withPackage = await assignPackage(db, organisation.id, client, packagesBySlug.get(CLIENT_PACKAGES[spec.name]!)!.id);
      const taskCount = await seedOnboardingTasks(db, organisation.id, withPackage.id, withPackage.createdAt, user.id);
      console.log("client        ", client.id, client.name);
      console.log("  site        ", site.id, site.primaryUrl);
      console.log("  monitor     ", monitor.id, `${monitor.target} every ${monitor.intervalSeconds}s`);
      console.log("  billing     ", billing.id, `terms ${billing.paymentTermsDays} days`);
      console.log("  contacts    ", spec.contacts.length);
      console.log("  domains     ", spec.domains.length, spec.domains.join(", "));
      console.log("  package     ", withPackage.packageId);
      console.log("  tasks       ", `${taskCount} onboarding tasks created`);
    }

    const clientUser = await seedClientUser(db, organisation.id, seededClients[0]!.id);
    console.log("client user   ", clientUser.id, `${CLIENT_USER.email} client_admin`);

    const billing = await seedBillingAndAds(db, organisation.id, seededClients);
    console.log(
      "billing/ads   ",
      `${billing.subscriptions} subscriptions, ${billing.invoices} invoices, ` +
        `${billing.snapshots} ad snapshots, ${billing.reports} published reports`,
    );
  } finally {
    await db.$client.end();
  }
}

type Db = ReturnType<typeof createDb>;

async function seedPackages(db: Db, organisationId: string) {
  const bySlug = new Map<string, typeof schema.packages.$inferSelect>();
  for (const spec of SEED_PACKAGES) {
    const [existing] = await db.select().from(schema.packages)
      .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.slug, spec.slug)));
    if (existing) { bySlug.set(spec.slug, existing); continue; }
    const [created] = await db.insert(schema.packages).values({ organisationId, ...spec }).returning();
    bySlug.set(spec.slug, created!);
  }
  return bySlug;
}

async function seedTaskTemplates(db: Db, organisationId: string, packagesBySlug: Map<string, typeof schema.packages.$inferSelect>) {
  const rows = [
    ...ONBOARDING_TEMPLATES.map((t) => ({ ...t, phase: "onboarding" as const, recurrence: "none" as const, packageId: null })),
    ...RECURRING_TEMPLATES.map((t) => ({
      title: t.title, kind: t.kind, sortOrder: t.sortOrder, checklist: t.checklist,
      phase: "recurring" as const, recurrence: t.recurrence, offsetDays: 0,
      defaultAssigneeRole: "any" as const,
      packageId: t.packageSlug ? packagesBySlug.get(t.packageSlug)!.id : null,
    })),
  ];

  let created = 0;
  for (const row of rows) {
    const [existing] = await db.select().from(schema.taskTemplates).where(and(
      eq(schema.taskTemplates.organisationId, organisationId),
      eq(schema.taskTemplates.phase, row.phase),
      eq(schema.taskTemplates.title, row.title),
    ));
    if (existing) continue;
    await db.insert(schema.taskTemplates).values({
      organisationId, packageId: row.packageId, phase: row.phase, kind: row.kind, title: row.title,
      offsetDays: row.offsetDays ?? 0, recurrence: row.recurrence,
      defaultAssigneeRole: row.defaultAssigneeRole, sortOrder: row.sortOrder, checklist: [...row.checklist],
    });
    created += 1;
  }
  return created;
}

async function assignPackage(db: Db, organisationId: string, client: typeof schema.clients.$inferSelect, packageId: string) {
  if (client.packageId === packageId) return client;
  const [updated] = await db.update(schema.clients)
    .set({ packageId, updatedAt: new Date() })
    .where(and(eq(schema.clients.id, client.id), eq(schema.clients.organisationId, organisationId)))
    .returning();
  return updated!;
}

/**
 * Mirrors generateOnboardingTasks. `packages/db` cannot import `@launchos/core`
 * (dependency direction is core → db), so the rules live twice: due date is
 * client.created_at + offset_days, owner-role templates go to the owner, and
 * (client_id, template_id) makes it idempotent.
 */
async function seedOnboardingTasks(db: Db, organisationId: string, clientId: string, createdAt: Date, ownerUserId: string) {
  const templates = await db.select().from(schema.taskTemplates).where(and(
    eq(schema.taskTemplates.organisationId, organisationId),
    eq(schema.taskTemplates.phase, "onboarding"),
  )).orderBy(asc(schema.taskTemplates.sortOrder));

  let created = 0;
  for (const template of templates) {
    const [existing] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
      eq(schema.tasks.clientId, clientId),
      eq(schema.tasks.templateId, template.id),
    ));
    if (existing) continue;
    await db.insert(schema.tasks).values({
      organisationId, clientId, templateId: template.id, phase: "onboarding", kind: template.kind,
      title: template.title, descriptionMd: template.descriptionMd,
      dueAt: new Date(createdAt.getTime() + template.offsetDays * 86_400_000),
      assigneeUserId: template.defaultAssigneeRole === "owner" ? ownerUserId : null,
      checklist: template.checklist.map((label) => ({ label, done: false })),
      createdByKind: "system",
    });
    created += 1;
  }
  return created;
}

async function seedOrganisation(db: Db) {
  const [existing] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, ORGANISATION.slug));
  if (existing) return existing;
  const [created] = await db.insert(schema.organisations).values({ ...ORGANISATION }).returning();
  return created!;
}

async function seedOwner(db: Db) {
  const [existing] = await db.select().from(schema.user).where(eq(schema.user.email, OWNER_EMAIL));
  const user =
    existing ??
    (await db
      .insert(schema.user)
      .values({ id: randomUUID(), name: OWNER_NAME, email: OWNER_EMAIL, emailVerified: true })
      .returning())[0]!;

  const [credential] = await db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
  if (!credential) {
    const password = await hashPassword(OWNER_PASSWORD);
    await db.insert(schema.account).values({
      id: randomUUID(),
      accountId: user.id,
      providerId: CREDENTIAL_PROVIDER,
      issuer: CREDENTIAL_ISSUER,
      userId: user.id,
      password,
    });
  }
  return user;
}

async function seedMembership(db: Db, organisationId: string, userId: string) {
  const [existing] = await db
    .select()
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, userId)));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.organisationMembers)
    .values({ organisationId, userId, role: "owner", status: "active" })
    .returning();
  return created!;
}

async function seedAgentEnablement(db: Db, organisationId: string, agentKey: string) {
  const [existing] = await db
    .select()
    .from(schema.agentEnablement)
    .where(and(eq(schema.agentEnablement.organisationId, organisationId), eq(schema.agentEnablement.agentKey, agentKey)));
  if (existing?.enabled) return existing;
  if (existing) {
    const [updated] = await db
      .update(schema.agentEnablement)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(schema.agentEnablement.id, existing.id))
      .returning();
    return updated!;
  }
  const [created] = await db
    .insert(schema.agentEnablement)
    .values({ organisationId, agentKey, enabled: true })
    .returning();
  return created!;
}

async function seedClient(db: Db, organisationId: string, spec: (typeof SEED_CLIENTS)[number]) {
  const [existing] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, spec.name)));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.clients)
    .values({
      organisationId,
      name: spec.name,
      slug: spec.slug,
      email: spec.email,
      supportEmail: `${spec.slug}@${SUPPORT_EMAIL_DOMAIN}`,
    })
    .returning();
  return created!;
}

async function seedSite(db: Db, organisationId: string, clientId: string, spec: (typeof SEED_CLIENTS)[number]) {
  const [existing] = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.organisationId, organisationId), eq(schema.sites.clientId, clientId), eq(schema.sites.name, spec.name)));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.sites)
    .values({ organisationId, clientId, name: spec.name, primaryUrl: spec.url })
    .returning();
  return created!;
}

async function seedBillingProfile(db: Db, organisationId: string, clientId: string, billingName: string) {
  const [existing] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.billingProfiles)
    .values({ organisationId, clientId, billingName, paymentTermsDays: 14 })
    .returning();
  return created!;
}

async function seedContacts(
  db: Db,
  organisationId: string,
  clientId: string,
  contacts: readonly { name: string; email: string; role: string; isPrimary: boolean }[],
) {
  for (const contact of contacts) {
    const [existing] = await db
      .select()
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.name, contact.name)));
    if (existing) continue;
    await db.insert(schema.clientContacts).values({ organisationId, clientId, ...contact });
  }
}

async function seedDomains(db: Db, organisationId: string, clientId: string, siteId: string, names: readonly string[]) {
  for (const [index, name] of names.entries()) {
    const [existing] = await db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.organisationId, organisationId), eq(schema.domains.name, name)));
    if (existing) continue;
    await db.insert(schema.domains).values({
      organisationId,
      clientId,
      // The first domain points at the site; any extra is held without one.
      siteId: index === 0 ? siteId : null,
      name,
      registrar: "Namecheap",
      dnsProvider: index === 0 ? "cloudflare" : "registrar",
      nameservers: index === 0 ? ["ns1.cloudflare.test", "ns2.cloudflare.test"] : [],
    });
  }
}

async function seedActivity(db: Db, organisationId: string, clientId: string, clientName: string, siteId: string) {
  const [existing] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, clientId));
  if (existing) return;
  await db.insert(schema.activityEvents).values([
    { organisationId, clientId, actorKind: "system", kind: "client.created", title: `Client created: ${clientName}`, link: `/clients/${clientId}` },
    { organisationId, clientId, siteId, actorKind: "system", kind: "site.created", title: "Website added", link: `/websites/${siteId}` },
    { organisationId, clientId, actorKind: "system", kind: "domain.created", title: "Domain added", link: `/clients/${clientId}?tab=sites` },
  ]);
}

async function seedStaffMember(db: Db, organisationId: string) {
  const [existingUser] = await db.select().from(schema.user).where(eq(schema.user.email, STAFF.email));
  const user =
    existingUser ??
    (await db.insert(schema.user).values({ id: randomUUID(), name: STAFF.name, email: STAFF.email, emailVerified: true }).returning())[0]!;
  const [existingMember] = await db
    .select()
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, user.id)));
  if (existingMember) return existingMember;
  // No credential row: the staff account gets its one-time password when an
  // owner adds it from the Team screen. The seed never invents a password.
  const [created] = await db
    .insert(schema.organisationMembers)
    .values({ organisationId, userId: user.id, role: "staff", status: "invited", displayName: STAFF.name, title: STAFF.title })
    .returning();
  return created!;
}

/**
 * A portal login for Grays CabLine. The password is a known env value rather
 * than the one-time password `createClientUser` generates, because a developer
 * has to be able to sign in to the portal after a fresh seed. Under
 * NODE_ENV=production it inherits the SEED_OWNER_PASSWORD guard in `main`.
 */
async function seedClientUser(db: Db, organisationId: string, clientId: string) {
  const [existingUser] = await db.select().from(schema.user).where(eq(schema.user.email, CLIENT_USER.email));
  const user =
    existingUser ??
    (await db
      .insert(schema.user)
      .values({ id: randomUUID(), name: CLIENT_USER.name, email: CLIENT_USER.email, emailVerified: true })
      .returning())[0]!;

  const [credential] = await db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
  if (!credential) {
    await db.insert(schema.account).values({
      id: randomUUID(),
      accountId: user.id,
      providerId: CREDENTIAL_PROVIDER,
      issuer: CREDENTIAL_ISSUER,
      userId: user.id,
      password: await hashPassword(CLIENT_USER.password),
    });
  }

  const [existingLink] = await db
    .select()
    .from(schema.clientUsers)
    .where(and(eq(schema.clientUsers.clientId, clientId), eq(schema.clientUsers.userId, user.id)));
  if (!existingLink) {
    await db.insert(schema.clientUsers).values({ organisationId, clientId, userId: user.id, role: "client_admin" });
  }
  return user;
}

/**
 * Returns the invoice this subscription already has for `issuedAt`'s calendar
 * month, otherwise raises one. The calendar month is the natural key: the
 * seed raises at most one invoice per subscription per month, so a re-run
 * finds the existing row instead of allocating a second invoice number.
 */
async function ensureInvoice(db: Db, organisationId: string, subscriptionId: string, issuedAt: Date) {
  const monthStart = new Date(Date.UTC(issuedAt.getUTCFullYear(), issuedAt.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(issuedAt.getUTCFullYear(), issuedAt.getUTCMonth() + 1, 1));
  const [existing] = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.organisationId, organisationId),
    eq(schema.invoices.subscriptionId, subscriptionId),
    gte(schema.invoices.issuedAt, monthStart),
    lt(schema.invoices.issuedAt, monthEnd),
  ));
  if (existing) return existing;
  return createInvoiceFromSubscription(db, organisationId, {
    subscriptionId, issuedAt, vatRatePercent: VAT_RATE_PERCENT, actorKind: "system",
  });
}

/**
 * Billing, ads and reporting demo data. Idempotent like the rest of the seed:
 * every step looks the row up by a natural key before creating anything, so a
 * second `pnpm db:seed` leaves the counts exactly where the first run left them.
 */
async function seedBillingAndAds(
  db: Db,
  organisationId: string,
  clients: { id: string; name: string; email: string }[],
) {
  const [pkg] = await db.select().from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.active, true)))
    .orderBy(asc(schema.packages.monthlyPricePence))
    .limit(1);
  if (!pkg) throw new Error("seed: no packages found — the package seed step must run before this one");

  const payments = new MockPaymentsAdapter({ vatRatePercent: VAT_RATE_PERCENT });
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  let subscriptionCount = 0;
  let invoiceCount = 0;
  for (const client of clients) {
    await seedBillingProfile(db, organisationId, client.id, client.name);

    const [existing] = await db.select().from(schema.subscriptions).where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      eq(schema.subscriptions.clientId, client.id),
    ));
    const subscription = existing ?? (await createSubscription(
      db,
      organisationId,
      { clientId: client.id, packageId: pkg.id, periodStart, actorKind: "system" },
      payments,
    )).subscription;
    subscriptionCount += 1;

    // Two invoices: last month settled, this month still due.
    const paid = await ensureInvoice(db, organisationId, subscription.id, lastMonth);
    if (paid.status !== "paid") {
      if (paid.status === "draft") {
        await markInvoiceSent(db, organisationId, { invoiceId: paid.id, actorKind: "system" });
      }
      await recordPayment(db, organisationId, {
        clientId: client.id, invoiceId: paid.id, amountPence: paid.totalPence,
        provider: "bank", providerRef: `seed-${paid.number}`, status: "succeeded", actorKind: "system",
      });
    }

    const due = await ensureInvoice(db, organisationId, subscription.id, periodStart);
    if (due.status === "draft") await markInvoiceSent(db, organisationId, { invoiceId: due.id, actorKind: "system" });
    invoiceCount += 2;
  }

  // One ad account for Grays CabLine with 30 days of deterministic metrics,
  // the last 7 of which show the ROAS slide the Sentinel is meant to catch.
  const grays = clients[0]!;
  const [account] = await db.select().from(schema.adAccounts).where(and(
    eq(schema.adAccounts.organisationId, organisationId),
    eq(schema.adAccounts.platform, AD_ACCOUNT.platform),
    eq(schema.adAccounts.externalId, AD_ACCOUNT.externalId),
  ));
  if (!account) await createAdAccount(db, organisationId, { clientId: grays.id, ...AD_ACCOUNT });

  const dropFrom = isoDay(new Date(now.getTime() - ROAS_DROP_DAYS * 86_400_000));
  const ads = new MockAdsAdapter({ dropFrom });
  let snapshots = 0;
  for (let offset = SNAPSHOT_DAYS; offset >= 1; offset--) {
    const date = isoDay(new Date(now.getTime() - offset * 86_400_000));
    // Upserts on (ad_account_id, date), so a re-run rewrites the same 30 rows.
    const result = await ingestDailyMetrics(db, organisationId, { date }, ads);
    snapshots += result.snapshots;
  }

  // One published report for last month so the portal has something to show.
  const report = await buildClientReport(db, organisationId, grays.id, monthPeriod(now));
  if (report.status === "draft") {
    await publishClientReport(db, organisationId, { reportId: report.id, actorId: "seed" });
  }

  // The Sentinel is enabled so the 07:00 cron has something to dispatch.
  await seedAgentEnablement(db, organisationId, SENTINEL_AGENT_KEY);

  return { subscriptions: subscriptionCount, invoices: invoiceCount, snapshots, reports: 1 };
}

async function seedMonitor(db: Db, organisationId: string, siteId: string, target: string) {
  const [existing] = await db
    .select()
    .from(schema.monitors)
    .where(and(eq(schema.monitors.organisationId, organisationId), eq(schema.monitors.siteId, siteId), eq(schema.monitors.target, target)));
  if (existing) return existing;
  const [created] = await db.insert(schema.monitors).values({ organisationId, siteId, target }).returning();
  return created!;
}

await main();
