import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { encryptSecret, loadEncryptionKey } from "../secrets/encryption.js";
import {
  assertClientInOrganisation,
  assertSiteBelongsToClient,
  assertSiteInOrganisation,
} from "../tenancy/assert-owned.js";

/**
 * The client access vault: the dashboards, servers, databases and panels we
 * hold a way into for a client, with the password encrypted at rest.
 *
 * Three rules hold everywhere in this directory, the same three as
 * `sites/site-credentials.ts`:
 *
 * 1. **The plaintext never leaves except through `revealAccessSecret`.** Not
 *    from the create or update result, not in an audit row, not in the list.
 *    A row only ever says `hasSecret`.
 * 2. **No key, no write.** `loadEncryptionKey` throws when
 *    `SECRETS_ENCRYPTION_KEY` is unset, before any row is touched, so a
 *    misconfigured deployment cannot hold a password in a column that was
 *    meant for ciphertext. An entry with no password needs no key.
 * 3. **Tenancy first.** Every id arrives from a form post and is checked
 *    against the organisation — and a site against the client — before
 *    anything is read or written.
 */

export const ACCESS_KINDS = [
  "dashboard",
  "server",
  "ssh",
  "database",
  "dns",
  "registrar",
  "hosting_panel",
  "email",
  "other",
] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

/** What the Access tab calls each kind. */
export const ACCESS_KIND_LABELS: Readonly<Record<AccessKind, string>> = {
  dashboard: "Dashboard",
  server: "Server",
  ssh: "SSH",
  database: "Database",
  dns: "DNS",
  registrar: "Registrar",
  hosting_panel: "Hosting panel",
  email: "Email",
  other: "Other",
};

/** The audit target type every entry action is recorded under. */
export const ACCESS_TARGET_TYPE = "client_access_entry";

const actor = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
};

/** `http(s)://` only: the tab renders it as a link that opens in a new tab. */
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https?:\/\//i, "Must be a full URL, with https://")
  .pipe(z.string().url("Must be a full URL, with https://"));

const fields = {
  siteId: z.string().uuid().nullish(),
  kind: z.enum(ACCESS_KINDS),
  label: z.string().trim().min(1, "Label is required").max(200),
  url: httpUrl.nullish(),
  host: z.string().trim().max(253).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  username: z.string().trim().max(200).nullish(),
  /** The password or key. Never blank: the web layer maps an untouched field to `undefined`. */
  secret: z.string().min(1).max(4000).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  sort: z.number().int().min(0).max(10_000).optional(),
};

export const CreateAccessEntryInput = z.object({ clientId: z.string().uuid(), ...fields, ...actor });
export type CreateAccessEntryInput = z.input<typeof CreateAccessEntryInput>;

export const UpdateAccessEntryInput = z.object({
  entryId: z.string().uuid(),
  siteId: fields.siteId,
  kind: fields.kind.optional(),
  label: fields.label.optional(),
  url: fields.url,
  host: fields.host,
  port: fields.port,
  username: fields.username,
  /** `undefined` leaves the stored secret alone, `null` clears it, a string replaces it. */
  secret: fields.secret,
  notes: fields.notes,
  sort: fields.sort,
  ...actor,
});
export type UpdateAccessEntryInput = z.input<typeof UpdateAccessEntryInput>;

export const DeleteAccessEntryInput = z.object({ entryId: z.string().uuid(), ...actor });
export type DeleteAccessEntryInput = z.input<typeof DeleteAccessEntryInput>;

/** One entry as the Access tab sees it: everything but the secret, plus whether there is one. */
export interface AccessEntryRow {
  id: string;
  clientId: string;
  siteId: string | null;
  siteName: string | null;
  kind: AccessKind;
  label: string;
  url: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  hasSecret: boolean;
  notes: string | null;
  sort: number;
  lastViewedAt: Date | null;
  lastViewedBy: string | null;
  lastViewedByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type StoredRow = typeof schema.clientAccessEntries.$inferSelect;

/**
 * What an audit row carries: the entry minus its password and minus its
 * notes. Notes are the one free-text field, and the one place someone might
 * paste a password despite the form telling them not to — so they stay out of
 * a table that is read far more widely than the vault.
 */
function snapshot(row: StoredRow) {
  return {
    clientId: row.clientId,
    siteId: row.siteId,
    kind: row.kind,
    label: row.label,
    url: row.url,
    host: row.host,
    port: row.port,
    username: row.username,
    hasSecret: row.secretCiphertext !== null,
  };
}

function toRow(row: StoredRow, siteName: string | null = null, lastViewedByName: string | null = null): AccessEntryRow {
  return {
    id: row.id,
    clientId: row.clientId,
    siteId: row.siteId,
    siteName,
    kind: row.kind,
    label: row.label,
    url: row.url,
    host: row.host,
    port: row.port,
    username: row.username,
    hasSecret: row.secretCiphertext !== null,
    notes: row.notes,
    sort: row.sort,
    lastViewedAt: row.lastViewedAt,
    lastViewedBy: row.lastViewedBy,
    lastViewedByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The entry, org-scoped, or a "not found" the caller can show. Never a cross-organisation read. */
export async function getStoredEntry(db: Db, organisationId: string, entryId: string): Promise<StoredRow> {
  const [row] = await db
    .select()
    .from(schema.clientAccessEntries)
    .where(and(eq(schema.clientAccessEntries.id, entryId), eq(schema.clientAccessEntries.organisationId, organisationId)))
    .limit(1);
  if (!row) throw new Error(`access entry ${entryId} not found in organisation`);
  return row;
}

async function assertSiteForClient(db: Db, organisationId: string, siteId: string, clientId: string): Promise<void> {
  await assertSiteInOrganisation(db, organisationId, siteId);
  await assertSiteBelongsToClient(db, organisationId, siteId, clientId);
}

export async function createAccessEntry(
  db: Db,
  organisationId: string,
  input: CreateAccessEntryInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccessEntryRow> {
  const v = CreateAccessEntryInput.parse(input);
  // Throws when a secret is given and the key is missing — before any row is written.
  const secretCiphertext = v.secret ? encryptSecret(v.secret, loadEncryptionKey(env)) : null;

  await assertClientInOrganisation(db, organisationId, v.clientId);
  if (v.siteId) await assertSiteForClient(db, organisationId, v.siteId, v.clientId);

  const [row] = await db
    .insert(schema.clientAccessEntries)
    .values({
      organisationId,
      clientId: v.clientId,
      siteId: v.siteId ?? null,
      kind: v.kind,
      label: v.label,
      url: v.url ?? null,
      host: v.host || null,
      port: v.port ?? null,
      username: v.username || null,
      secretCiphertext,
      notes: v.notes || null,
      sort: v.sort ?? 0,
      createdBy: v.actorId ?? null,
      updatedBy: v.actorId ?? null,
    })
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind,
    actorId: v.actorId,
    action: "client_access.created",
    targetType: ACCESS_TARGET_TYPE,
    targetId: row!.id,
    after: snapshot(row!),
  });
  return toRow(row!);
}

/**
 * Changes only the fields given. `secret` follows the three-way rule on the
 * input type; every other nullable field takes `null` to clear and
 * `undefined` to leave alone.
 */
export async function updateAccessEntry(
  db: Db,
  organisationId: string,
  input: UpdateAccessEntryInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccessEntryRow> {
  const v = UpdateAccessEntryInput.parse(input);
  // Key first, row second: a missing key must not even read the entry it would have changed.
  const secretCiphertext = v.secret ? encryptSecret(v.secret, loadEncryptionKey(env)) : v.secret;

  const before = await getStoredEntry(db, organisationId, v.entryId);
  if (v.siteId) await assertSiteForClient(db, organisationId, v.siteId, before.clientId);

  const set: Partial<typeof schema.clientAccessEntries.$inferInsert> = { updatedAt: new Date(), updatedBy: v.actorId ?? null };
  if (v.siteId !== undefined) set.siteId = v.siteId;
  if (v.kind !== undefined) set.kind = v.kind;
  if (v.label !== undefined) set.label = v.label;
  if (v.url !== undefined) set.url = v.url;
  if (v.host !== undefined) set.host = v.host || null;
  if (v.port !== undefined) set.port = v.port;
  if (v.username !== undefined) set.username = v.username || null;
  if (secretCiphertext !== undefined) set.secretCiphertext = secretCiphertext;
  if (v.notes !== undefined) set.notes = v.notes || null;
  if (v.sort !== undefined) set.sort = v.sort;

  const [row] = await db
    .update(schema.clientAccessEntries)
    .set(set)
    .where(and(eq(schema.clientAccessEntries.id, v.entryId), eq(schema.clientAccessEntries.organisationId, organisationId)))
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind,
    actorId: v.actorId,
    action: "client_access.updated",
    targetType: ACCESS_TARGET_TYPE,
    targetId: row!.id,
    before: snapshot(before),
    after: snapshot(row!),
  });
  return toRow(row!);
}

/** Removes the entry. Its audit trail — including every reveal — stays. */
export async function deleteAccessEntry(
  db: Db,
  organisationId: string,
  input: DeleteAccessEntryInput,
): Promise<{ id: string; clientId: string }> {
  const v = DeleteAccessEntryInput.parse(input);
  const before = await getStoredEntry(db, organisationId, v.entryId);

  await db
    .delete(schema.clientAccessEntries)
    .where(and(eq(schema.clientAccessEntries.id, v.entryId), eq(schema.clientAccessEntries.organisationId, organisationId)));

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind,
    actorId: v.actorId,
    action: "client_access.deleted",
    targetType: ACCESS_TARGET_TYPE,
    targetId: before.id,
    before: snapshot(before),
  });
  return { id: before.id, clientId: before.clientId };
}

/**
 * Every entry for one client, without a single byte of ciphertext: the select
 * names its columns so the secret column cannot come along by accident.
 * Ordered for the tab — `sort`, then label — which groups them by kind itself.
 */
export async function listAccessEntries(db: Db, organisationId: string, clientId: string): Promise<AccessEntryRow[]> {
  const e = schema.clientAccessEntries;
  const rows = await db
    .select({
      id: e.id,
      clientId: e.clientId,
      siteId: e.siteId,
      siteName: schema.sites.name,
      kind: e.kind,
      label: e.label,
      url: e.url,
      host: e.host,
      port: e.port,
      username: e.username,
      hasSecret: sql<boolean>`${e.secretCiphertext} is not null`,
      notes: e.notes,
      sort: e.sort,
      lastViewedAt: e.lastViewedAt,
      lastViewedBy: e.lastViewedBy,
      lastViewedByName: schema.user.name,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })
    .from(e)
    .leftJoin(schema.sites, eq(schema.sites.id, e.siteId))
    .leftJoin(schema.user, eq(schema.user.id, e.lastViewedBy))
    .where(and(eq(e.organisationId, organisationId), eq(e.clientId, clientId)))
    .orderBy(asc(e.sort), asc(e.label), asc(e.createdAt));
  return rows.map((row) => ({ ...row, hasSecret: Boolean(row.hasSecret) }));
}
