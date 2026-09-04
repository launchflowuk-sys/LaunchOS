/**
 * Re-points every client's support address at the configured SUPPORT_EMAIL_DOMAIN.
 *
 * Why this exists. A client's support address is stored twice: in
 * `clients.support_email`, which is what the admin UI displays, and in
 * `email_identities.address`, which is what inbound routing actually matches on
 * (`findIdentityClientId` in `packages/core/src/support/ingest-inbound-email.ts`
 * and the inbound webhook both look the address up in `email_identities`).
 * Both are globally unique. Two things put them out of step:
 *
 *  - Migration 0007 backfilled `clients.support_email` for rows that predated
 *    the column using the literal fallback domain, because a migration cannot
 *    read env. A deployment that sets SUPPORT_EMAIL_DOMAIN to anything else ends
 *    up with backfilled clients on a domain it does not control — mail to them
 *    never resolves, silently, per email, forever. `ensureEmailIdentity`
 *    early-returns whenever an identity already exists, so it never repairs the
 *    routing copy either.
 *  - The same backfill derives a globally-unique value from a
 *    per-organisation-unique one (`slug`), so two organisations with a client
 *    that slugifies the same way collide — in both tables.
 *
 * This rewrites **both** tables, in one transaction, so the displayed address
 * and the routable one can never disagree. It is safe to re-run: it is a no-op
 * when every row already matches. Run it after changing SUPPORT_EMAIL_DOMAIN,
 * and after restoring or merging a database that carries more than one
 * organisation.
 *
 *   pnpm db:reconcile-support-emails -- --dry-run   # print the plan, change nothing
 *   pnpm db:reconcile-support-emails -- --yes       # apply it
 *
 * SUPPORT_EMAIL_DOMAIN must be set: a mass rewrite is not a place for an
 * implicit fallback, so falling back to the built-in default requires
 * `--allow-default-domain` said out loud.
 *
 * Collisions are resolved deterministically and without disturbing addresses
 * that are already correct: the oldest organisation keeps `<slug>@<domain>` and
 * every later one gets `<slug>-<org-slug>@<domain>`.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "../client.js";
import { loadRootEnv, ROOT_ENV_FILE } from "../env-target.js";
import * as schema from "../schema/index.js";

/**
 * Same value as `DEFAULT_SUPPORT_EMAIL_DOMAIN` in
 * `packages/core/src/config.ts`. Exported so the cross-check test can hold the
 * two against each other — see the note on `Domain` below for why they are not
 * simply one constant.
 */
export const DEFAULT_SUPPORT_EMAIL_DOMAIN = "support.launchflow.co.uk";

/**
 * Same value as `HOLDING_CLIENT_SLUG` in
 * `packages/core/src/support/ingest-inbound-email.ts`. The holding client is a
 * bucket that unroutable mail is filed under, not a routable client: its
 * `support_email` is deliberately NULL and it must never be given an address,
 * or mail addressed to `unmatched@<domain>` becomes deliverable into it.
 *
 * Exported for the same reason as the constant above.
 */
export const HOLDING_CLIENT_SLUG = "unmatched";

// Same shape as `supportEmailDomain` in packages/core/src/config.ts.
//
// Duplicated rather than imported, deliberately: `@launchos/core` is a
// *devDependency* of this package, so it is not installed in the production
// image this script has to run in — importing it would turn a repair tool into
// a module-not-found at the exact moment someone needs it. The duplication is
// held in step by `support-email-constants.cross-check.test.ts`, which fails
// the build if either copy moves without the other.
const Domain = z
  .string()
  .min(4)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

export function resolveDomain(env: NodeJS.ProcessEnv, allowDefault: boolean): string {
  const raw = env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase();
  if (raw) return Domain.parse(raw);
  if (!allowDefault) {
    throw new Error(
      "SUPPORT_EMAIL_DOMAIN is not set. Set it to the domain this deployment actually receives mail on, " +
        `or pass --allow-default-domain to rewrite every address to the built-in ${DEFAULT_SUPPORT_EMAIL_DOMAIN}.`,
    );
  }
  return DEFAULT_SUPPORT_EMAIL_DOMAIN;
}

type ClientRow = {
  id: string;
  organisationId: string;
  orgSlug: string;
  slug: string;
  name: string;
  supportEmail: string | null;
  identityId: string | null;
  identityAddress: string | null;
};

export type Change = {
  client: ClientRow;
  /** Current `clients.support_email`. */
  from: string | null;
  /** Current `email_identities.address`, or null when the client has no identity row yet. */
  identityFrom: string | null;
  to: string;
};

/**
 * Pure so it can be reasoned about (and tested) without a database. Rows must
 * arrive in a stable order — oldest organisation first — because the first
 * claimant of a local part keeps it.
 *
 * The holding client is skipped outright: it is a bucket, not a routable
 * client, and it neither claims a local part nor gets an address.
 */
export function planReconciliation(rows: readonly ClientRow[], domain: string): Change[] {
  const taken = new Set<string>();
  const changes: Change[] = [];

  for (const client of rows) {
    if (client.slug === HOLDING_CLIENT_SLUG) continue;

    let local = client.slug;
    if (taken.has(local)) local = `${client.slug}-${client.orgSlug}`;
    for (let n = 2; taken.has(local); n += 1) local = `${client.slug}-${client.orgSlug}-${n}`;
    taken.add(local);

    const to = `${local}@${domain}`;
    // Either copy being out of step is a reason to write: the displayed address
    // and the routable one have to end up the same string.
    if (client.supportEmail !== to || client.identityAddress !== to) {
      changes.push({ client, from: client.supportEmail, identityFrom: client.identityAddress, to });
    }
  }
  return changes;
}

export async function loadClients(db: Db): Promise<ClientRow[]> {
  return db
    .select({
      id: schema.clients.id,
      organisationId: schema.clients.organisationId,
      orgSlug: schema.organisations.slug,
      slug: schema.clients.slug,
      name: schema.clients.name,
      supportEmail: schema.clients.supportEmail,
      identityId: schema.emailIdentities.id,
      identityAddress: schema.emailIdentities.address,
    })
    .from(schema.clients)
    .innerJoin(schema.organisations, eq(schema.clients.organisationId, schema.organisations.id))
    .leftJoin(schema.emailIdentities, eq(schema.emailIdentities.clientId, schema.clients.id))
    .orderBy(
      asc(schema.organisations.createdAt),
      asc(schema.organisations.id),
      asc(schema.clients.createdAt),
      asc(schema.clients.id),
    );
}

/**
 * `email_identities.address` is NOT NULL, so the clear step cannot use NULL the
 * way `clients.support_email` does. A placeholder built from the identity's own
 * id is unique by construction, and `.invalid` is reserved by RFC 2606 so it can
 * never route even if a crash left one behind.
 */
const parkedAddress = (identityId: string) => `reconcile-${identityId}@invalid`;

/**
 * Both `clients_support_email` and `email_identities_address` are plain
 * (non-deferrable) unique indexes, so a one-by-one rewrite can trip over an
 * address another row is about to give up. Clearing every changing row first
 * makes the whole set safe to re-assign, and the single transaction means a
 * failure leaves nothing half-cleared and the two tables never disagree.
 */
export async function applyChanges(db: Db, changes: readonly Change[]): Promise<void> {
  if (changes.length === 0) return;

  await db.transaction(async (tx) => {
    const clientEmailChanges = changes.filter((c) => c.from !== c.to);
    const identityChanges = changes.filter(
      (c): c is Change & { client: ClientRow & { identityId: string } } =>
        c.client.identityId !== null && c.identityFrom !== c.to,
    );

    if (clientEmailChanges.length > 0) {
      await tx
        .update(schema.clients)
        .set({ supportEmail: null, updatedAt: new Date() })
        .where(inArray(schema.clients.id, clientEmailChanges.map((c) => c.client.id)));
    }
    for (const change of identityChanges) {
      await tx
        .update(schema.emailIdentities)
        .set({ address: parkedAddress(change.client.identityId), updatedAt: new Date() })
        .where(eq(schema.emailIdentities.id, change.client.identityId));
    }

    for (const change of clientEmailChanges) {
      await tx
        .update(schema.clients)
        .set({ supportEmail: change.to, updatedAt: new Date() })
        .where(eq(schema.clients.id, change.client.id));

      await tx.insert(schema.auditLog).values({
        organisationId: change.client.organisationId,
        actorKind: "system",
        action: "client.support_email_reconciled",
        targetType: "client",
        targetId: change.client.id,
        before: { supportEmail: change.from },
        after: { supportEmail: change.to },
      });
    }

    for (const change of identityChanges) {
      await tx
        .update(schema.emailIdentities)
        .set({ address: change.to, updatedAt: new Date() })
        .where(eq(schema.emailIdentities.id, change.client.identityId));

      await tx.insert(schema.auditLog).values({
        organisationId: change.client.organisationId,
        actorKind: "system",
        action: "email_identity.address_reconciled",
        targetType: "email_identity",
        targetId: change.client.identityId,
        before: { address: change.identityFrom },
        after: { address: change.to },
      });
    }

    // A client with no identity row has no routable address at all; the
    // reconciled address is the one it must get, not the one
    // `ensureEmailIdentity` would derive later from the raw slug (which is the
    // address a collision just moved this client off). Same shape that helper
    // inserts — the inbound secret is per identity and never audited.
    for (const change of changes) {
      if (change.client.identityId !== null) continue;

      const [created] = await tx
        .insert(schema.emailIdentities)
        .values({
          organisationId: change.client.organisationId,
          clientId: change.client.id,
          address: change.to,
          displayName: `${change.client.name} Support`,
          inboundSecret: randomBytes(24).toString("hex"),
        })
        .returning({ id: schema.emailIdentities.id, address: schema.emailIdentities.address });

      await tx.insert(schema.auditLog).values({
        organisationId: change.client.organisationId,
        actorKind: "system",
        action: "email_identity.created",
        targetType: "email_identity",
        targetId: created!.id,
        after: { id: created!.id, clientId: change.client.id, address: created!.address },
      });
    }
  });
}

const FLAGS = ["--dry-run", "--yes", "--allow-default-domain"] as const;

export function parseFlags(argv: readonly string[]): { dryRun: boolean; yes: boolean; allowDefaultDomain: boolean } {
  for (const arg of argv) {
    // pnpm forwards its own end-of-options separator through to the script.
    if (arg === "--") continue;
    if (!(FLAGS as readonly string[]).includes(arg)) {
      throw new Error(`unknown argument "${arg}". Valid flags: ${FLAGS.join(", ")}`);
    }
  }
  return {
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
    allowDefaultDomain: argv.includes("--allow-default-domain"),
  };
}

async function main(): Promise<void> {
  // The shared loader from `../env-target.js`: the repo-root `.env`, resolved
  // from the package's own path rather than from `process.cwd()`, and merged
  // key by key so a `DATABASE_URL` already exported in the shell does not stop
  // SUPPORT_EMAIL_DOMAIN being read. This script kept a private cwd-relative
  // ladder of `../../.env`, `../.env`, `.env`, which was only correct when run
  // from `packages/db`: from the repository root its first candidate resolves
  // *two directories above the repository*, so a stray file there would win and
  // configure a mass rewrite of every routable address; run from anywhere else
  // it found nothing at all, and the fallback domain — the exact damage this
  // script exists to repair — was one --allow-default-domain away.
  const envFile = loadRootEnv();
  // First, and before the domain is resolved: "SUPPORT_EMAIL_DOMAIN is not set"
  // is a refusal an operator answers by looking at the file they put it in, so
  // the file this run actually read is the one thing that line needs beside it.
  const envSource = envFile ?? `none found at ${ROOT_ENV_FILE}; using the process environment only`;
  process.stdout.write(`env file: ${envSource}\n`);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to reconcile support emails");

  const flags = parseFlags(process.argv.slice(2));
  const domain = resolveDomain(process.env, flags.allowDefaultDomain);
  const db = createDb(url);

  process.stdout.write(`Reconciling client support addresses to @${domain}\n`);

  const rows = await loadClients(db);
  const changes = planReconciliation(rows, domain);

  if (changes.length === 0) {
    process.stdout.write(`All ${rows.length} client support addresses already match @${domain}.\n`);
    return;
  }

  for (const change of changes) {
    process.stdout.write(
      `${change.client.orgSlug}/${change.client.slug}: ` +
        `clients.support_email ${change.from ?? "(none)"} -> ${change.to}; ` +
        `email_identities.address ${change.identityFrom ?? "(none, will be created)"} -> ${change.to}\n`,
    );
  }
  if (flags.dryRun) {
    process.stdout.write(`\n--dry-run: ${changes.length} of ${rows.length} would change. Nothing written.\n`);
    return;
  }
  if (!flags.yes) {
    process.stdout.write(`\n${changes.length} of ${rows.length} would change. Re-run with --yes to apply.\n`);
    return;
  }

  await applyChanges(db, changes);
  process.stdout.write(`\nRe-pointed ${changes.length} of ${rows.length} client support addresses at @${domain}.\n`);
}

// Only when run as a script: the pure helpers are imported by the test, and
// importing this module must not open a connection or rewrite anything.
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`reconcile-support-emails failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
