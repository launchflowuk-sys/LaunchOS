/**
 * Development seed: one organisation, the owner account, two real clients with
 * a site and an uptime monitor each, and the Hosting Guard-Dog agent enabled.
 *
 * Idempotent: every step looks the row up (by slug / email / name / target)
 * before inserting, so `pnpm db:seed` can be run repeatedly.
 *
 * The owner password comes from SEED_OWNER_PASSWORD (default "change-me-now").
 * Never commit a real password here.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { createDb } from "./client.js";
import * as schema from "./schema/index.js";

loadRootEnv();

const OWNER_EMAIL = "shujaat@nexusedu.co.uk";
const OWNER_NAME = "Shoji";
const ORGANISATION = { slug: "launchflow", name: "LaunchFlow" } as const;
const AGENT_KEY = "hosting-guard-dog";

const SEED_CLIENTS = [
  { name: "Grays CabLine", email: "info@grayscabline.co.uk", url: "https://grayscabline.co.uk" },
  { name: "Mobile PC Doctor", email: "info@mobilepcdoctor.co.uk", url: "https://mobilepcdoctor.co.uk" },
] as const;

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
  const db = createDb(url);

  try {
    const organisation = await seedOrganisation(db);
    const user = await seedOwner(db);
    const membership = await seedMembership(db, organisation.id, user.id);
    const enablement = await seedAgentEnablement(db, organisation.id);

    console.log("organisation  ", organisation.id, organisation.slug);
    console.log("owner user    ", user.id, user.email);
    console.log("membership    ", membership.id, membership.role);
    console.log("agent         ", enablement.id, `${enablement.agentKey} enabled=${enablement.enabled}`);

    for (const spec of SEED_CLIENTS) {
      const client = await seedClient(db, organisation.id, spec);
      const site = await seedSite(db, organisation.id, client.id, spec);
      const monitor = await seedMonitor(db, organisation.id, site.id, spec.url);
      console.log("client        ", client.id, client.name);
      console.log("  site        ", site.id, site.primaryUrl);
      console.log("  monitor     ", monitor.id, `${monitor.target} every ${monitor.intervalSeconds}s`);
    }
  } finally {
    await db.$client.end();
  }
}

type Db = ReturnType<typeof createDb>;

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
    .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential")));
  if (!credential) {
    const password = await hashPassword(process.env.SEED_OWNER_PASSWORD ?? "change-me-now");
    await db
      .insert(schema.account)
      .values({ id: randomUUID(), accountId: user.id, providerId: "credential", userId: user.id, password });
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

async function seedAgentEnablement(db: Db, organisationId: string) {
  const [existing] = await db
    .select()
    .from(schema.agentEnablement)
    .where(and(eq(schema.agentEnablement.organisationId, organisationId), eq(schema.agentEnablement.agentKey, AGENT_KEY)));
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
    .values({ organisationId, agentKey: AGENT_KEY, enabled: true })
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
    .values({ organisationId, name: spec.name, email: spec.email })
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
