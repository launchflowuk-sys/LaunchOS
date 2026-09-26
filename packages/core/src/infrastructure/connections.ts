import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { coolifyInstanceClient, hetznerClient, type CoolifyInstanceClient, type HetznerClient } from "@launchos/integrations";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { decryptSecret, encryptSecret, loadEncryptionKey } from "../secrets/encryption.js";

/**
 * Encrypted API credentials for Hetzner projects and Coolify instances.
 *
 * The plaintext token never leaves this module except through
 * `connectionSecret()`. It is not returned from any of the CRUD functions, not
 * audited and not logged. `createConnection`/`updateConnection` always call
 * the provider first — a token that does not work is never written.
 */
export interface InfraDeps {
  hetzner?: (token: string) => HetznerClient;
  coolify?: (url: string, token: string) => CoolifyInstanceClient;
  env?: NodeJS.ProcessEnv;
}
export const hetznerFor = (deps: InfraDeps, token: string) => (deps.hetzner ?? hetznerClient)(token);
export const coolifyFor = (deps: InfraDeps, url: string, token: string) => (deps.coolify ?? coolifyInstanceClient)(url, token);

export const ConnectionInput = z
  .object({
    provider: z.enum(["hetzner_cloud", "coolify"]),
    label: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().url().nullish(),
    token: z.string().trim().min(1).max(500),
    actorId: z.string().min(1),
  })
  .refine((v) => v.provider !== "coolify" || !!v.baseUrl, { message: "A Coolify connection needs its URL, e.g. http://1.2.3.4:8000", path: ["baseUrl"] });
export type ConnectionInput = z.input<typeof ConnectionInput>;

export interface ConnectionRow {
  id: string;
  provider: "hetzner_cloud" | "coolify";
  label: string;
  baseUrl: string | null;
  serverId: string | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
}
const PUBLIC = {
  id: schema.infraConnections.id,
  provider: schema.infraConnections.provider,
  label: schema.infraConnections.label,
  baseUrl: schema.infraConnections.baseUrl,
  serverId: schema.infraConnections.serverId,
  lastSyncedAt: schema.infraConnections.lastSyncedAt,
  lastError: schema.infraConnections.lastError,
};
const owned = (organisationId: string, id: string) =>
  and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, id));

/** Calls the provider with the token. The only way a connection gets saved. */
export async function testConnection(
  input: { provider: "hetzner_cloud" | "coolify"; baseUrl?: string | null | undefined; token: string },
  deps: InfraDeps = {},
): Promise<{ ok: true; detail: string } | { ok: false; message: string }> {
  try {
    if (input.provider === "hetzner_cloud") {
      const servers = await hetznerFor(deps, input.token).listServers();
      return { ok: true, detail: `${servers.length} server${servers.length === 1 ? "" : "s"}` };
    }
    const version = await coolifyFor(deps, input.baseUrl ?? "", input.token).version();
    return { ok: true, detail: `Coolify ${version}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The provider could not be reached." };
  }
}

export async function createConnection(db: Db, organisationId: string, raw: ConnectionInput, deps: InfraDeps = {}): Promise<ConnectionRow> {
  const input = ConnectionInput.parse(raw);
  const key = loadEncryptionKey(deps.env); // no key, no write
  const test = await testConnection(input, deps);
  if (!test.ok) throw new Error(test.message);
  const [row] = await db
    .insert(schema.infraConnections)
    .values({
      organisationId,
      provider: input.provider,
      label: input.label,
      baseUrl: input.baseUrl ?? null,
      tokenEncrypted: encryptSecret(input.token, key),
    })
    .returning(PUBLIC);
  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: input.actorId,
    action: "infra.connection.create",
    targetType: "infra_connection",
    targetId: row!.id,
    after: { provider: input.provider, label: input.label, baseUrl: input.baseUrl ?? null },
  });
  return row!;
}

export const UpdateConnectionInput = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().url().nullish(),
  token: z.string().trim().min(1).max(500).optional(),
  serverId: z.string().uuid().nullish(),
  actorId: z.string().min(1),
});

export async function updateConnection(
  db: Db,
  organisationId: string,
  raw: z.input<typeof UpdateConnectionInput>,
  deps: InfraDeps = {},
): Promise<ConnectionRow> {
  const input = UpdateConnectionInput.parse(raw);
  const [before] = await db.select().from(schema.infraConnections).where(owned(organisationId, input.id));
  if (!before) throw new Error("Connection not found.");
  if (input.serverId) {
    const [srv] = await db
      .select({ id: schema.servers.id })
      .from(schema.servers)
      .where(and(eq(schema.servers.organisationId, organisationId), eq(schema.servers.id, input.serverId)));
    if (!srv) throw new Error("Server not found.");
  }
  let tokenEncrypted: string | undefined;
  if (input.token) {
    const baseUrl = input.baseUrl ?? before.baseUrl;
    const test = await testConnection({ provider: before.provider, baseUrl, token: input.token }, deps);
    if (!test.ok) throw new Error(test.message);
    tokenEncrypted = encryptSecret(input.token, loadEncryptionKey(deps.env));
  }
  const [row] = await db
    .update(schema.infraConnections)
    .set({
      ...(input.label ? { label: input.label } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
      ...(tokenEncrypted ? { tokenEncrypted, lastError: null } : {}),
      updatedAt: new Date(),
    })
    .where(owned(organisationId, input.id))
    .returning(PUBLIC);
  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: input.actorId,
    action: "infra.connection.update",
    targetType: "infra_connection",
    targetId: input.id,
    before: { label: before.label, baseUrl: before.baseUrl, serverId: before.serverId },
    after: { label: row!.label, baseUrl: row!.baseUrl, serverId: row!.serverId, tokenReplaced: !!tokenEncrypted },
  });
  return row!;
}

export async function removeConnection(db: Db, organisationId: string, input: { id: string; actorId: string }): Promise<void> {
  const [gone] = await db
    .delete(schema.infraConnections)
    .where(owned(organisationId, input.id))
    .returning({ id: schema.infraConnections.id, label: schema.infraConnections.label, provider: schema.infraConnections.provider });
  if (!gone) return;
  await recordAudit(db, organisationId, {
    actorKind: "user",
    actorId: input.actorId,
    action: "infra.connection.remove",
    targetType: "infra_connection",
    targetId: gone.id,
    before: { label: gone.label, provider: gone.provider },
  });
}

export async function listConnections(db: Db, organisationId: string): Promise<ConnectionRow[]> {
  return db
    .select(PUBLIC)
    .from(schema.infraConnections)
    .where(eq(schema.infraConnections.organisationId, organisationId))
    .orderBy(asc(schema.infraConnections.provider), asc(schema.infraConnections.label));
}

/** The only reader of plaintext. Server-side callers only. */
export async function connectionSecret(db: Db, organisationId: string, id: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const [row] = await db.select({ t: schema.infraConnections.tokenEncrypted }).from(schema.infraConnections).where(owned(organisationId, id));
  if (!row) throw new Error("Connection not found.");
  return decryptSecret(row.t, loadEncryptionKey(env));
}

/**
 * One-off carrier: reads HETZNER_API_TOKENS (comma list, and every line of
 * that name when the caller passes a merged value) and COOLIFY_<NAME>=url|token.
 * Coolify tokens contain `|` themselves — split on the FIRST one only.
 * Labels are the dedupe key, so running it twice adds nothing.
 */
export async function importConnectionsFromEnv(
  db: Db,
  organisationId: string,
  source: Record<string, string | undefined>,
  actorId: string,
  deps: InfraDeps = {},
): Promise<{ added: string[]; skipped: string[]; failed: { label: string; message: string }[] }> {
  const existing = new Set((await listConnections(db, organisationId)).map((c) => c.label));
  const wanted: ConnectionInput[] = [];
  const skipped: string[] = [];

  (source.HETZNER_API_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .forEach((token, i) => wanted.push({ provider: "hetzner_cloud", label: `Hetzner — account ${i + 1}`, token, actorId }));

  for (const [key, value] of Object.entries(source)) {
    const m = /^COOLIFY_([A-Z0-9_]+)$/.exec(key);
    if (!m || !value || !value.includes("|") || !/^https?:\/\//.test(value)) continue;
    const cut = value.indexOf("|");
    const baseUrl = value.slice(0, cut).trim();
    const token = value.slice(cut + 1).trim();
    const label = `Coolify — ${m[1]}`;
    if (!token) {
      skipped.push(label);
      continue;
    }
    wanted.push({ provider: "coolify", label, baseUrl, token, actorId });
  }

  const added: string[] = [];
  const failed: { label: string; message: string }[] = [];
  for (const input of wanted) {
    if (existing.has(input.label)) continue;
    try {
      await createConnection(db, organisationId, input, deps);
      added.push(input.label);
    } catch (error) {
      failed.push({ label: input.label, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { added, skipped, failed };
}
