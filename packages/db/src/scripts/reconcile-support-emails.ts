/**
 * Re-points every `clients.support_email` at the configured SUPPORT_EMAIL_DOMAIN.
 *
 * Why this exists. `clients.support_email` is minted as `<slug>@<domain>` when a
 * client is created, and Plan 4's inbound routing matches incoming mail on the
 * address alone. Two things put rows out of step with that:
 *
 *  - Migration 0007 backfilled rows that predated the column using the literal
 *    fallback domain, because a migration cannot read env. A deployment that
 *    sets SUPPORT_EMAIL_DOMAIN to anything else ends up with backfilled clients
 *    on a domain it does not control — mail to them never resolves, silently,
 *    per email, forever.
 *  - The same backfill derives a globally-unique column (`support_email` is
 *    unique across every organisation) from a per-organisation-unique one
 *    (`slug`), so two organisations with a client that slugifies the same way
 *    collide.
 *
 * This script fixes both, and is safe to re-run: it is a no-op when every row
 * already matches. Run it after changing SUPPORT_EMAIL_DOMAIN, and after
 * restoring or merging a database that carries more than one organisation.
 *
 *   pnpm db:reconcile-support-emails            # apply
 *   pnpm db:reconcile-support-emails --dry-run  # print the plan, change nothing
 *
 * Collisions are resolved deterministically and without disturbing addresses
 * that are already correct: the oldest organisation keeps `<slug>@<domain>` and
 * every later one gets `<slug>-<org-slug>@<domain>`.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "../client.js";
import * as schema from "../schema/index.js";

const DEFAULT_SUPPORT_EMAIL_DOMAIN = "support.launchflow.co.uk";

// Same shape as `supportEmailDomain` in packages/core/src/config.ts. Duplicated
// rather than imported because `@launchos/core` is only a devDependency here and
// this script has to run in a production image.
const Domain = z
  .string()
  .min(4)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

function supportEmailDomain(env: NodeJS.ProcessEnv): string {
  const raw = env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!raw) return DEFAULT_SUPPORT_EMAIL_DOMAIN;
  return Domain.parse(raw);
}

function loadRootEnv(): void {
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

type ClientRow = {
  id: string;
  organisationId: string;
  orgSlug: string;
  slug: string;
  supportEmail: string | null;
};

export type Change = { client: ClientRow; from: string | null; to: string };

/**
 * Pure so it can be reasoned about (and tested) without a database. Rows must
 * arrive in a stable order — oldest organisation first — because the first
 * claimant of a local part keeps it.
 */
export function planReconciliation(rows: readonly ClientRow[], domain: string): Change[] {
  const taken = new Set<string>();
  const changes: Change[] = [];

  for (const client of rows) {
    let local = client.slug;
    if (taken.has(local)) local = `${client.slug}-${client.orgSlug}`;
    for (let n = 2; taken.has(local); n += 1) local = `${client.slug}-${client.orgSlug}-${n}`;
    taken.add(local);

    const to = `${local}@${domain}`;
    if (client.supportEmail !== to) changes.push({ client, from: client.supportEmail, to });
  }
  return changes;
}

async function loadClients(db: Db): Promise<ClientRow[]> {
  return db
    .select({
      id: schema.clients.id,
      organisationId: schema.clients.organisationId,
      orgSlug: schema.organisations.slug,
      slug: schema.clients.slug,
      supportEmail: schema.clients.supportEmail,
    })
    .from(schema.clients)
    .innerJoin(schema.organisations, eq(schema.clients.organisationId, schema.organisations.id))
    .orderBy(
      asc(schema.organisations.createdAt),
      asc(schema.organisations.id),
      asc(schema.clients.createdAt),
      asc(schema.clients.id),
    );
}

/**
 * `clients_support_email` is a plain (non-deferrable) unique index, so a
 * one-by-one rewrite can trip over an address another row is about to give up.
 * Clearing every changing row first makes the whole set safe to re-assign, and
 * the transaction means a failure leaves nothing half-cleared.
 */
async function applyChanges(db: Db, changes: readonly Change[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.clients)
      .set({ supportEmail: null, updatedAt: new Date() })
      .where(inArray(schema.clients.id, changes.map((c) => c.client.id)));

    for (const change of changes) {
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
  });
}

async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to reconcile support emails");

  const dryRun = process.argv.includes("--dry-run");
  const domain = supportEmailDomain(process.env);
  const db = createDb(url);

  const rows = await loadClients(db);
  const changes = planReconciliation(rows, domain);

  if (changes.length === 0) {
    process.stdout.write(`All ${rows.length} client support addresses already match @${domain}.\n`);
    return;
  }

  for (const change of changes) {
    process.stdout.write(`${change.client.orgSlug}/${change.client.slug}: ${change.from ?? "(none)"} -> ${change.to}\n`);
  }
  if (dryRun) {
    process.stdout.write(`\n--dry-run: ${changes.length} of ${rows.length} would change. Nothing written.\n`);
    return;
  }

  await applyChanges(db, changes);
  process.stdout.write(`\nRe-pointed ${changes.length} of ${rows.length} client support addresses at @${domain}.\n`);
}

// Only when run as a script: `planReconciliation` is imported by its test, and
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
