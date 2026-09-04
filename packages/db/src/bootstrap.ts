/**
 * Production bootstrap: the organisation and the owner account, and nothing
 * else.
 *
 * `pnpm db:seed` is a **development** fixture. It writes demo clients, sites,
 * monitors, knowledge articles, a fabricated support case, a portal login,
 * subscriptions, invoices with numbers from a live sequence, payments, ad
 * snapshots and published reports. None of that belongs in a live tenant, and
 * invoice numbers in particular are not cleanly reversible. So the first
 * account on a production install comes from here instead:
 *
 * ```bash
 * docker exec <web-container> pnpm db:bootstrap
 * ```
 *
 * Idempotent: the organisation is looked up by slug, the user by email and the
 * credential by user. Re-running it never changes an existing password — to
 * rotate one, sign in and change it, or delete the `account` row first.
 *
 * Agents are left disabled; enable the ones you want in Settings → Agents.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./client.js";
import * as schema from "./schema/index.js";

/** Published in this repository, so it must never reach a live database. */
export const DEFAULT_OWNER_PASSWORD = "change-me-now";
export const DEFAULT_CLIENT_PASSWORD = "change-me-client";
export const DEFAULT_OWNER_EMAIL = "shujaat@nexusedu.co.uk";

// Better Auth namespaces credential accounts as "local:<providerId>"
// (createLocalAccountIssuer in @better-auth/core/db, not publicly exported).
export const CREDENTIAL_PROVIDER = "credential";
export const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;

/**
 * Loads the repo-root `.env` when the process was not given a DATABASE_URL.
 * Shared with the seed so both scripts behave the same from any cwd.
 */
export function loadRootEnv(): void {
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

export interface BootstrapInput {
  organisationName: string;
  organisationSlug: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
}

/**
 * Rejects a bootstrap that would install a password published in this
 * repository. Exported so the guard can be tested without a database.
 */
export function assertBootstrapAllowed(input: { ownerPassword: string }, nodeEnv: string | undefined): void {
  if (nodeEnv !== "production") return;
  if (input.ownerPassword === DEFAULT_OWNER_PASSWORD || input.ownerPassword === DEFAULT_CLIENT_PASSWORD) {
    throw new Error(
      "SEED_OWNER_PASSWORD is still a default published in this repository. " +
        "Set a real one in the resource environment, bootstrap once, then remove it and redeploy.",
    );
  }
}

/** The organisation, by slug. Never touches an existing row. */
export async function ensureOrganisation(db: Db, input: { name: string; slug: string }) {
  const [existing] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, input.slug));
  if (existing) return { row: existing, created: false };
  const [created] = await db.insert(schema.organisations).values({ name: input.name, slug: input.slug }).returning();
  return { row: created!, created: true };
}

/**
 * The user and its credential account. An existing user keeps its password:
 * a re-run must never silently reset a live login.
 */
export async function ensureOwnerUser(db: Db, input: { email: string; name: string; password: string }) {
  const [existing] = await db.select().from(schema.user).where(eq(schema.user.email, input.email));
  const user =
    existing ??
    (await db
      .insert(schema.user)
      .values({ id: randomUUID(), name: input.name, email: input.email, emailVerified: true })
      .returning())[0]!;

  const [credential] = await db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, CREDENTIAL_PROVIDER)));
  if (credential) return { row: user, created: !existing, passwordSet: false };

  await db.insert(schema.account).values({
    id: randomUUID(),
    accountId: user.id,
    providerId: CREDENTIAL_PROVIDER,
    issuer: CREDENTIAL_ISSUER,
    userId: user.id,
    password: await hashPassword(input.password),
  });
  return { row: user, created: !existing, passwordSet: true };
}

/** Owner membership of the organisation. */
export async function ensureOwnerMembership(db: Db, organisationId: string, userId: string) {
  const [existing] = await db
    .select()
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.userId, userId),
      ),
    );
  if (existing) return existing;
  const [created] = await db
    .insert(schema.organisationMembers)
    .values({ organisationId, userId, role: "owner", status: "active" })
    .returning();
  return created!;
}

export interface BootstrapResult {
  organisationId: string;
  organisationCreated: boolean;
  userId: string;
  userCreated: boolean;
  passwordSet: boolean;
}

export async function bootstrap(db: Db, input: BootstrapInput): Promise<BootstrapResult> {
  const organisation = await ensureOrganisation(db, { name: input.organisationName, slug: input.organisationSlug });
  const owner = await ensureOwnerUser(db, {
    email: input.ownerEmail,
    name: input.ownerName,
    password: input.ownerPassword,
  });
  await ensureOwnerMembership(db, organisation.row.id, owner.row.id);
  return {
    organisationId: organisation.row.id,
    organisationCreated: organisation.created,
    userId: owner.row.id,
    userCreated: owner.created,
    passwordSet: owner.passwordSet,
  };
}

/** Reads the five variables the bootstrap is configured by. */
export function bootstrapInputFromEnv(env: NodeJS.ProcessEnv): BootstrapInput {
  return {
    organisationName: env.SEED_ORG_NAME ?? "LaunchFlow",
    organisationSlug: env.SEED_ORG_SLUG ?? "launchflow",
    ownerEmail: env.SEED_OWNER_EMAIL ?? DEFAULT_OWNER_EMAIL,
    ownerName: env.SEED_OWNER_NAME ?? "Owner",
    ownerPassword: env.SEED_OWNER_PASSWORD ?? DEFAULT_OWNER_PASSWORD,
  };
}

async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to bootstrap");
  const input = bootstrapInputFromEnv(process.env);
  assertBootstrapAllowed(input, process.env.NODE_ENV);

  const db = createDb(url);
  try {
    const result = await bootstrap(db, input);
    console.log("organisation  ", result.organisationId, input.organisationSlug, result.organisationCreated ? "created" : "already present");
    console.log("owner user    ", result.userId, input.ownerEmail, result.userCreated ? "created" : "already present");
    console.log("password      ", result.passwordSet ? "set from SEED_OWNER_PASSWORD" : "left as it was");
    console.log("No demo data was written. Enable agents in Settings → Agents.");
  } finally {
    await db.$client.end();
  }
}

// Only when run as a script: this module is imported by the seed (for the
// shared helpers) and by its own test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
