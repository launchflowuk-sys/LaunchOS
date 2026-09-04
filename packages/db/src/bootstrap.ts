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
import { isProductionTarget, productionTargetReason, type TargetEnv } from "./env-target.js";
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

/** Where the repo-root `.env` sits, relative to any cwd either script is run from. */
const ENV_FILE_CANDIDATES = ["../../.env", "../.env", ".env"] as const;

/**
 * Merges the repo-root `.env` into `process.env`, and returns the file it
 * read.
 *
 * **Every key, not just `DATABASE_URL`.** This used to return immediately when
 * `DATABASE_URL` was already in the environment, which meant the one-off run
 * that matters most — `DATABASE_URL=postgres://…live… pnpm db:bootstrap` —
 * never saw the `SEED_OWNER_PASSWORD` the operator had put in `.env`, silently
 * fell back to the published default, and then printed that the password came
 * from the variable it had not read.
 *
 * `process.loadEnvFile` leaves keys that are already set alone, so an explicit
 * variable on the command line still wins over the file; the file only fills
 * the gaps.
 */
export function loadRootEnv(): string | null {
  const hadDatabaseUrl = Boolean(process.env.DATABASE_URL);
  for (const candidate of ENV_FILE_CANDIDATES) {
    const path = resolve(process.cwd(), candidate);
    try {
      process.loadEnvFile(path);
    } catch {
      continue; // file absent — try the next candidate
    }
    // A file that supplies the connection string is the repo root. When the
    // connection string came from the command line instead, the first file
    // that loads is as good an answer as we can get.
    if (hadDatabaseUrl || process.env.DATABASE_URL) return path;
  }
  return null;
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
 * What every slug in this system looks like: lowercase alphanumerics and
 * hyphens, starting on an alphanumeric, 2–63 characters.
 */
export const ORGANISATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * The slug this run would write, in **every** environment.
 *
 * An organisation is found by slug and created when no row has it, so the slug
 * is the tenant's identity. `SEED_ORG_SLUG=` — present but empty, which is
 * what pasting `.env.example` into a resource and clearing the box produces —
 * used to sail through as `""`: `notNull` accepts an empty string, so it
 * created a nameless organisation, and `BOOTSTRAP_CONFIRM=` (also shipped
 * empty) confirmed it by comparing equal.
 */
export function assertOrganisationSlug(slug: string): void {
  if (ORGANISATION_SLUG_PATTERN.test(slug)) return;
  throw new BootstrapGuardError(
    "organisation-slug",
    (slug === ""
      ? "SEED_ORG_SLUG is set but empty."
      : `SEED_ORG_SLUG is "${slug}", which is not a valid slug.`) +
      " It must be 2–63 characters of lowercase letters, digits and hyphens, starting with a letter or " +
      "digit. The organisation is looked up by this value and created when nothing matches, so a blank " +
      "or malformed one makes a second, nameless tenant rather than finding yours. Leave the variable " +
      `unset to use "${DEFAULT_ORGANISATION_SLUG}".`,
  );
}

/**
 * The pre-flight guards, in order. Exported so they can be tested without a
 * database.
 *
 * 1. **password-floor** — every environment. The app's own floor
 *    (`MIN_PASSWORD_LENGTH`) applies to the owner account too; Better Auth
 *    only checks it on sign-up, change and reset, none of which this account
 *    will ever go through, so this is the only place it can be applied.
 * 2. **organisation-slug** — every environment. See above.
 * 3. **published-default** — production target. A password printed in this
 *    repository must never reach a live database.
 * 4. **confirm-slug** — production target. `BOOTSTRAP_CONFIRM` must equal the
 *    slug about to be written, so a mistyped `SEED_ORG_SLUG` creates a refusal
 *    rather than a second, empty organisation nobody notices.
 *
 * "Production target" is `isProductionTarget`: `NODE_ENV=production`, **or** a
 * `DATABASE_URL` that does not point at localhost, the compose network or a
 * private address. Keying 3 and 4 on `NODE_ENV` alone meant the run that most
 * needed them — a one-off against a live database from a shell where nobody
 * exported `NODE_ENV` — was the one run that skipped them.
 */
export function assertBootstrapAllowed(
  input: { organisationSlug: string; ownerPassword: string },
  env: TargetEnv & { BOOTSTRAP_CONFIRM?: string | undefined },
): void {
  if (input.ownerPassword.length < MIN_PASSWORD_LENGTH) {
    throw new BootstrapGuardError("password-floor", shortPasswordMessage("SEED_OWNER_PASSWORD", input.ownerPassword));
  }

  assertOrganisationSlug(input.organisationSlug);

  if (!isProductionTarget(env)) return;
  const because = `Refusing because ${productionTargetReason(env)}.`;

  if (isPublishedDefaultPassword(input.ownerPassword)) {
    throw new BootstrapGuardError(
      "published-default",
      "SEED_OWNER_PASSWORD is still a default published in this repository. " +
        "Set a real one in the resource environment, bootstrap once, then remove it and redeploy. " +
        because,
    );
  }

  const confirm = (env.BOOTSTRAP_CONFIRM ?? "").trim();
  if (confirm !== input.organisationSlug) {
    throw new BootstrapGuardError(
      "confirm-slug",
      `BOOTSTRAP_CONFIRM must be set to the organisation slug this run would write, "${input.organisationSlug}"` +
        (confirm === "" ? " (it is unset or empty)." : `, not "${confirm}".`) +
        " The bootstrap creates an organisation whenever it finds no row with that slug, so a mistyped " +
        "SEED_ORG_SLUG would silently create a second, empty one. Confirming the slug is how you say you " +
        `meant this exact value. ${because}`,
    );
  }
}

/**
 * A connection or an open transaction. `bootstrap()` runs its writes inside
 * one transaction; the same helpers are called outside one by the seed.
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The organisation, by slug. Never touches an existing row. */
export async function ensureOrganisation(db: DbOrTx, input: { name: string; slug: string }) {
  const [existing] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, input.slug));
  if (existing) return { row: existing, created: false };
  const [created] = await db.insert(schema.organisations).values({ name: input.name, slug: input.slug }).returning();
  return { row: created!, created: true };
}

/** The user row alone, by email. No credential is written here. */
export async function ensureUserRow(db: DbOrTx, input: { email: string; name: string }) {
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
export async function ensureOwnerCredential(db: DbOrTx, userId: string, password: string) {
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
 * Owner membership of the organisation.
 *
 * An existing row that is not an active owner is a refusal, not a success: a
 * staff or invited membership means this email belongs to somebody else's
 * account, and reporting "already present" would leave the operator with a
 * bootstrap that claims to have made them an owner and a sign-in that rejects
 * them (`apps/web/src/lib/session.ts` requires `status = "active"`).
 */
export async function ensureOwnerMembership(db: DbOrTx, organisationId: string, userId: string) {
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
 *
 * All of it runs in one transaction. A crash between the user row and its
 * credential would otherwise leave an owner who can neither sign in nor sign
 * up (`emailAndPassword.disableSignUp`) until somebody re-ran the bootstrap.
 */
export async function bootstrap(db: Db, input: BootstrapInput): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    const organisation = await ensureOrganisation(tx, { name: input.organisationName, slug: input.organisationSlug });
    const owner = await ensureUserRow(tx, { email: input.ownerEmail, name: input.ownerName });
    await ensureOwnerMembership(tx, organisation.row.id, owner.row.id);
    const credential = await ensureOwnerCredential(tx, owner.row.id, input.ownerPassword);
    return {
      organisationId: organisation.row.id,
      organisationCreated: organisation.created,
      userId: owner.row.id,
      userCreated: owner.created,
      passwordSet: credential.passwordSet,
    };
  });
}

/**
 * The organisation both entry points create, from the environment.
 *
 * Values are trimmed, because `SEED_ORG_SLUG="launchflow "` pasted into a
 * resource box would otherwise be a *different* organisation from
 * `launchflow`, and confirming it with the same stray space would confirm the
 * wrong one. **Unset** falls back to the default; **set but empty** does not —
 * it survives as `""` so `assertOrganisationSlug` can refuse it, which is the
 * mistake worth catching rather than papering over. The name is cosmetic, so
 * an empty one falls back rather than refusing.
 */
export function organisationFromEnv(env: NodeJS.ProcessEnv): { name: string; slug: string } {
  const name = env.SEED_ORG_NAME?.trim();
  return {
    name: name === undefined || name === "" ? DEFAULT_ORGANISATION_NAME : name,
    slug: env.SEED_ORG_SLUG?.trim() ?? DEFAULT_ORGANISATION_SLUG,
  };
}

/**
 * Where the owner password actually came from, for the log line.
 *
 * `main` used to print `set from SEED_OWNER_PASSWORD` whether or not that
 * variable had been read, which is the sentence an operator reads to confirm
 * their password took.
 */
export function ownerPasswordSource(env: NodeJS.ProcessEnv): string {
  return env.SEED_OWNER_PASSWORD
    ? "set from SEED_OWNER_PASSWORD"
    : "set from the built-in default (SEED_OWNER_PASSWORD was unset)";
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
  const envFile = loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new BootstrapGuardError("database-url", "DATABASE_URL is required to bootstrap");
  // Before the guards, not after: an operator who trips one needs to know
  // which database they were pointed at, which is usually the actual mistake.
  console.log("database      ", describeDatabase(url), isProductionTarget(process.env) ? "(production target)" : "(local)");
  console.log("env file      ", envFile ?? "none found; using the process environment only");

  const input = bootstrapInputFromEnv(process.env);
  assertBootstrapAllowed(input, process.env);

  console.log("organisation  ", input.organisationSlug, `(${input.organisationName})`);

  const db = createDb(url);
  try {
    const result = await bootstrap(db, input);
    console.log("organisation  ", result.organisationId, input.organisationSlug, result.organisationCreated ? "created" : "already present");
    console.log("owner user    ", result.userId, input.ownerEmail, result.userCreated ? "created" : "already present");
    console.log("password      ", result.passwordSet ? ownerPasswordSource(process.env) : "existing credential kept");
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
