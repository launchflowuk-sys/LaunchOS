import type { WordPressSiteConnection } from "@launchos/integrations";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertSiteInOrganisation } from "../tenancy/assert-owned.js";
import { decryptSecret, encryptSecret, loadEncryptionKey } from "../secrets/encryption.js";

/**
 * The per-site WordPress credential: set it, read it back, and answer "is this
 * site connected?" without decrypting anything.
 *
 * Three rules hold everywhere in this file:
 *
 * 1. **The plaintext never leaves this module except through
 *    `getSiteCmsCredential`.** It is not audited, not logged, not returned from
 *    the setter and not stored in `metadata`.
 * 2. **No key, no write.** `loadEncryptionKey` throws when
 *    `SECRETS_ENCRYPTION_KEY` is unset, before the row is touched, so a
 *    misconfigured deployment cannot end up holding a password in a column that
 *    was supposed to be ciphertext.
 * 3. **Tenancy first.** The site id arrives from a form post, so it is checked
 *    against the organisation before anything is read or written.
 */

const KIND = "wordpress_app_password" as const;

export const SetSiteCmsCredentialInput = z.object({
  siteId: z.string().uuid(),
  username: z.string().trim().min(1, "Username is required").max(200),
  /**
   * WordPress issues these as four-character groups with spaces. Not trimmed of
   * internal whitespace — the spaces are part of what the operator was shown,
   * and WordPress accepts the value either way.
   */
  appPassword: z.string().trim().min(1, "Application password is required").max(500),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type SetSiteCmsCredentialInput = z.input<typeof SetSiteCmsCredentialInput>;

export interface SiteCmsCredential {
  readonly username: string;
  readonly appPassword: string;
}

/** What the admin screen shows: connected or not, and as whom. Never the secret. */
export interface SiteCmsCredentialStatus {
  readonly username: string;
  readonly updatedAt: Date;
  readonly createdBy: string | null;
}

/**
 * Stores (or replaces) the application password for one site.
 *
 * Replacing rather than versioning: a rotated password makes the old one dead
 * weight, and keeping superseded ciphertext around is a liability with no
 * reader. The unique index on `(site_id, kind)` is what makes the upsert exact.
 */
export async function setSiteCmsCredential(
  db: Db,
  organisationId: string,
  input: SetSiteCmsCredentialInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { siteId, username, appPassword, actorKind, actorId } = SetSiteCmsCredentialInput.parse(input);
  // Throws when the key is missing or malformed — before any row is written.
  const key = loadEncryptionKey(env);

  await assertSiteInOrganisation(db, organisationId, siteId);
  const [site] = await db
    .select({ platform: schema.sites.platform })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId)));
  if (site!.platform !== "wordpress") {
    throw new Error(`site ${siteId} is recorded as ${site!.platform}, so a WordPress credential does not apply to it`);
  }

  const secretCiphertext = encryptSecret(appPassword, key);
  const [row] = await db
    .insert(schema.siteCredentials)
    .values({ organisationId, siteId, kind: KIND, username, secretCiphertext, createdBy: actorId ?? null })
    .onConflictDoUpdate({
      target: [schema.siteCredentials.siteId, schema.siteCredentials.kind],
      set: { username, secretCiphertext, createdBy: actorId ?? null, updatedAt: new Date() },
    })
    .returning();

  // `after` deliberately carries the username and nothing else: the audit trail
  // must say who connected what, and must never become a place the password is
  // readable in plaintext.
  await recordAudit(db, organisationId, {
    actorKind,
    actorId,
    action: "site_credential.set",
    targetType: "site",
    targetId: siteId,
    after: { siteId, kind: KIND, username },
  });

  return { id: row!.id, siteId, kind: KIND, username, updatedAt: row!.updatedAt };
}

/** The decrypted credential, or null when this site has none. */
export async function getSiteCmsCredential(
  db: Db,
  organisationId: string,
  siteId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SiteCmsCredential | null> {
  const [row] = await db
    .select({ username: schema.siteCredentials.username, secretCiphertext: schema.siteCredentials.secretCiphertext })
    .from(schema.siteCredentials)
    .where(
      and(
        eq(schema.siteCredentials.organisationId, organisationId),
        eq(schema.siteCredentials.siteId, siteId),
        eq(schema.siteCredentials.kind, KIND),
      ),
    );
  if (!row) return null;
  return { username: row.username, appPassword: decryptSecret(row.secretCiphertext, loadEncryptionKey(env)) };
}

/**
 * Whether a site is connected, without decrypting. The website page renders on
 * every request and has no business touching the key to draw a badge.
 */
export async function getSiteCmsCredentialStatus(
  db: Db,
  organisationId: string,
  siteId: string,
): Promise<SiteCmsCredentialStatus | null> {
  const [row] = await db
    .select({
      username: schema.siteCredentials.username,
      updatedAt: schema.siteCredentials.updatedAt,
      createdBy: schema.siteCredentials.createdBy,
    })
    .from(schema.siteCredentials)
    .where(
      and(
        eq(schema.siteCredentials.organisationId, organisationId),
        eq(schema.siteCredentials.siteId, siteId),
        eq(schema.siteCredentials.kind, KIND),
      ),
    );
  return row ?? null;
}

/**
 * The `resolveSiteCredentials` callback `WordPressCmsProvider` is constructed
 * with, bound to one organisation.
 *
 * It lives here rather than in `packages/integrations` because it needs the
 * database and the decryption key, and that package is a leaf that has neither.
 * Returning `null` — rather than throwing — for an unknown or unconnected site
 * is what lets the provider raise its own typed `no_credentials`.
 */
export function siteCredentialResolver(db: Db, organisationId: string, env: NodeJS.ProcessEnv = process.env) {
  return async (siteId: string): Promise<WordPressSiteConnection | null> => {
    const [site] = await db
      .select({ primaryUrl: schema.sites.primaryUrl, platform: schema.sites.platform })
      .from(schema.sites)
      .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId)));
    if (!site) return null;

    const credential = await getSiteCmsCredential(db, organisationId, siteId, env);
    if (!credential) return null;

    return {
      baseUrl: site.primaryUrl,
      platform: site.platform,
      username: credential.username,
      appPassword: credential.appPassword,
    };
  };
}
