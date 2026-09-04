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
 * Every refusal is loud. A guard throws a `BootstrapGuardError` naming itself,
 * `main` prints that name and the reason, and the process exits non-zero: a
 * bootstrap that did not do what you asked must never look like one that did.
 *
 * Agents are left disabled; enable the ones you want in Settings → Agents.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./client.js";
import {
  DEFAULT_OWNER_EMAIL,
  DEFAULT_OWNER_PASSWORD,
  isPublishedDefaultPassword,
  MIN_PASSWORD_LENGTH,
  shortPasswordMessage,
} from "./passwords.js";
import * as schema from "./schema/index.js";

// Better Auth namespaces credential accounts as "local:<providerId>"
// (createLocalAccountIssuer in @better-auth/core/db, not publicly exported).
export const CREDENTIAL_PROVIDER = "credential";
export const CREDENTIAL_ISSUER = `local:${CREDENTIAL_PROVIDER}`;

/** Defaults for the organisation both entry points create. */
export const DEFAULT_ORGANISATION_NAME = "LaunchFlow";
export const DEFAULT_ORGANISATION_SLUG = "launchflow";

/**
 * A refusal by one of the pre-flight guards, carrying the guard's name so the
 * operator is told which line stopped them rather than being left to guess.
 */
export class BootstrapGuardError extends Error {
  readonly guard: string;

  constructor(guard: string, message: string) {
    super(message);
    this.name = "BootstrapGuardError";
    this.guard = guard;
  }
}

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

/** Host and database of a connection string, with the credentials left out. Never log the URL itself. */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
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
 * The three pre-flight guards, in order. Exported so they can be tested
 * without a database.
 *
 * 1. **password-floor** — every environment. The app's own floor
 *    (`MIN_PASSWORD_LENGTH`) applies to the owner account too; Better Auth
 *    only checks it on sign-up, change and reset, none of which this account
 *    will ever go through, so this is the only place it can be applied.
 * 2. **published-default** — production. A password printed in this
 *    repository must never reach a live database.
 * 3. **confirm-slug** — production. `BOOTSTRAP_CONFIRM` must equal the slug
 *    about to be written, so a mistyped `SEED_ORG_SLUG` creates a refusal
 *    rather than a second, empty organisation nobody notices.
 */
export function assertBootstrapAllowed(
  input: { organisationSlug: string; ownerPassword: string },
  env: { NODE_ENV?: string | undefined; BOOTSTRAP_CONFIRM?: string | undefined },
): void {
  if (input.ownerPassword.length < MIN_PASSWORD_LENGTH) {
    throw new BootstrapGuardError("password-floor", shortPasswordMessage("SEED_OWNER_PASSWORD", input.ownerPassword));
  }

  if (env.NODE_ENV !== "production") return;

  if (isPublishedDefaultPassword(input.ownerPassword)) {
    throw new BootstrapGuardError(
      "published-default",
      "SEED_OWNER_PASSWORD is still a default published in this repository. " +
        "Set a real one in the resource environment, bootstrap once, then remove it and redeploy.",
    );
  }

  if (env.BOOTSTRAP_CONFIRM !== input.organisationSlug) {
    throw new BootstrapGuardError(
      "confirm-slug",
      `BOOTSTRAP_CONFIRM must be set to the organisation slug this run would write, "${input.organisationSlug}"` +
        (env.BOOTSTRAP_CONFIRM ? `, not "${env.BOOTSTRAP_CONFIRM}".` : " (it is unset).") +
        " The bootstrap creates an organisation whenever it finds no row with that slug, so a mistyped " +
        "SEED_ORG_SLUG would silently create a second, empty one. Confirming the slug is how you say you " +
        "meant this exact value.",
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

/** The user row alone, by email. No credential is written here. */
export async function ensureUserRow(db: Db, input: { email: string; name: string }) {
  const [existing] = await db.select().from(schema.user).where(eq(schema.user.email, input.email));
  if (existing) return { row: existing, created: false };
  const [created] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), name: input.name, email: input.email, emailVerified: true })
    .returning();
  return { row: created!, created: true };
}

/**
 * The credential account, and only when the user has no `account` row of any
 * kind.
 *
 * The narrower "no *credential* row" test was not enough: a user invited
 * through /team, or linked to any other provider, is an existing account whose
 * sign-in this script has no business changing. If anything is already there,
 * the existing credential is kept and the caller is told so.
 */
export async function ensureOwnerCredential(db: Db, userId: string, password: string) {
  const existing = await db.select().from(schema.account).where(eq(schema.account.userId, userId));
  if (existing.length > 0) return { passwordSet: false };

  await db.insert(schema.account).values({
    id: randomUUID(),
    accountId: userId,
    providerId: CREDENTIAL_PROVIDER,
    issuer: CREDENTIAL_ISSUER,
    userId,
    password: await hashPassword(password),
  });
  return { passwordSet: true };
}

/**
 * The user and its credential account. An existing user keeps its password:
 * a re-run must never silently reset a live login.
 */
export async function ensureOwnerUser(db: Db, input: { email: string; name: string; password: string }) {
  const user = await ensureUserRow(db, { email: input.email, name: input.name });
  const credential = await ensureOwnerCredential(db, user.row.id, input.password);
  return { row: user.row, created: user.created, passwordSet: credential.passwordSet };
}

/**
 * Owner membership of the organisation.
 *
 * An existing row that is not an active owner is a refusal, not a success: a
 * staff or invited membership means this email belongs to somebody else's
 * account, and reporting "already present" would leave the operator with a
 * bootstrap that claims to have made them an owner and a sign-in that rejects
 * them (`apps/web/src/lib/session.ts` requires `status = "active"`).
 */
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
  if (existing) {
    if (existing.role !== "owner" || existing.status !== "active") {
      throw new BootstrapGuardError(
        "existing-membership",
        `That email already belongs to a member of this organisation with role "${existing.role}" and status ` +
          `"${existing.status}", not an active owner. Refusing to report an owner bootstrap that did not happen. ` +
          "Use a different SEED_OWNER_EMAIL, or promote the existing member in Settings → Team.",
      );
    }
    return existing;
  }
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

/**
 * Order matters: the membership is settled **before** any credential is
 * written, so a refusal on a non-owner membership cannot leave a password
 * behind on somebody else's account.
 */
export async function bootstrap(db: Db, input: BootstrapInput): Promise<BootstrapResult> {
  const organisation = await ensureOrganisation(db, { name: input.organisationName, slug: input.organisationSlug });
  const owner = await ensureUserRow(db, { email: input.ownerEmail, name: input.ownerName });
  await ensureOwnerMembership(db, organisation.row.id, owner.row.id);
  const credential = await ensureOwnerCredential(db, owner.row.id, input.ownerPassword);
  return {
    organisationId: organisation.row.id,
    organisationCreated: organisation.created,
    userId: owner.row.id,
    userCreated: owner.created,
    passwordSet: credential.passwordSet,
  };
}

/** The organisation both entry points create, from the environment. */
export function organisationFromEnv(env: NodeJS.ProcessEnv): { name: string; slug: string } {
  return {
    name: env.SEED_ORG_NAME ?? DEFAULT_ORGANISATION_NAME,
    slug: env.SEED_ORG_SLUG ?? DEFAULT_ORGANISATION_SLUG,
  };
}

/** Reads the five variables the bootstrap is configured by. */
export function bootstrapInputFromEnv(env: NodeJS.ProcessEnv): BootstrapInput {
  const organisation = organisationFromEnv(env);
  return {
    organisationName: organisation.name,
    organisationSlug: organisation.slug,
    ownerEmail: env.SEED_OWNER_EMAIL ?? DEFAULT_OWNER_EMAIL,
    ownerName: env.SEED_OWNER_NAME ?? "Owner",
    ownerPassword: env.SEED_OWNER_PASSWORD ?? DEFAULT_OWNER_PASSWORD,
  };
}

async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new BootstrapGuardError("database-url", "DATABASE_URL is required to bootstrap");
  const input = bootstrapInputFromEnv(process.env);
  assertBootstrapAllowed(input, process.env);

  console.log("database      ", describeDatabase(url));
  console.log("organisation  ", input.organisationSlug, `(${input.organisationName})`);

  const db = createDb(url);
  try {
    const result = await bootstrap(db, input);
    console.log("organisation  ", result.organisationId, input.organisationSlug, result.organisationCreated ? "created" : "already present");
    console.log("owner user    ", result.userId, input.ownerEmail, result.userCreated ? "created" : "already present");
    console.log("password      ", result.passwordSet ? "set from SEED_OWNER_PASSWORD" : "existing credential kept");
    console.log("No demo data was written. Enable agents in Settings → Agents.");
  } finally {
    await db.$client.end();
  }
}

// Only when run as a script: this module is imported by the seed (for the
// shared helpers) and by its own test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    if (error instanceof BootstrapGuardError) {
      console.error(`\ndb:bootstrap refused — guard "${error.guard}"\n${error.message}`);
    } else {
      console.error("\ndb:bootstrap failed", error);
    }
    process.exitCode = 1;
  }
}
