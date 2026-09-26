import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { HetznerClient } from "@launchos/integrations";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { cancelSyncedCosts, connectionSecret, coolifyFor, hetznerFor, listConnections, type InfraDeps } from "./connections.js";
import { serverCost } from "./cost.js";

const DAY = 86_400_000;
/**
 * A pending action older than this is cleared unconditionally, even if
 * `getAction` keeps failing (pruned id, revoked token, deleted connection)
 * or never leaves "running". Without this, a claim id of `0` — written for
 * an instant while `runServerAction` is between claiming the row and
 * learning Hetzner's real action id — 404s forever if the process dies in
 * that window, and the server is locked out of every future action.
 */
const PENDING_ACTION_STALE_MS = 15 * 60_000;
/**
 * How long a claim placeholder (`pendingAction.id === 0`) is left alone
 * before it is treated as abandoned. `runServerAction` holds id `0` only for
 * the length of one Hetzner request — clearing it sooner reopens the race
 * the claim exists to prevent: a sync landing inside that window would clear
 * the row, a second concurrent `runServerAction` would then pass the
 * `pendingAction IS NULL` guard, and both would fire the action. Longer than
 * any single Hetzner request should ever take.
 */
const CLAIM_PLACEHOLDER_GRACE_MS = 2 * 60_000;

/**
 * One pass over every connection. Each connection is its own try/catch: a
 * revoked token on one account must not blank the other nine servers.
 * Server rows are telemetry (exempt from audit_log, like uptime_checks); the
 * cost rows follow the Hostinger sync's rules.
 */
export async function syncInfrastructure(db: Db, organisationId: string, deps: InfraDeps & { now?: Date } = {}) {
  const now = deps.now ?? new Date();
  const connections = await listConnections(db, organisationId);
  const report: { label: string; ok: boolean; error?: string }[] = [];
  let serverCount = 0;

  // Each connection is its own try/catch and records its own outcome.
  const attempt = async (conn: (typeof connections)[number], run: (token: string) => Promise<void>) => {
    try {
      await run(await connectionSecret(db, organisationId, conn.id, deps.env));
      await markConnection(db, organisationId, conn.id, null, now);
      report.push({ label: conn.label, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markConnection(db, organisationId, conn.id, message, now);
      report.push({ label: conn.label, ok: false, error: message });
    }
  };

  for (const conn of connections.filter((c) => c.provider === "hetzner_cloud")) {
    await attempt(conn, async (token) => {
      serverCount += await syncHetznerAccount(db, organisationId, conn.id, conn.label, hetznerFor(deps, token), now);
    });
  }
  // Coolify is checked for reachability only (GET /api/v1/version).
  for (const conn of connections.filter((c) => c.provider === "coolify" && c.baseUrl)) {
    await attempt(conn, async (token) => {
      await coolifyFor(deps, conn.baseUrl!, token).version();
    });
  }

  await linkCoolifyByIp(db, organisationId, connections);
  return { servers: serverCount, connections: report };
}

async function syncHetznerAccount(db: Db, organisationId: string, connectionId: string, label: string, client: HetznerClient, now: Date) {
  const [list, volumes, primaryIps, snapshots, pricing] = await Promise.all([
    client.listServers(), client.listVolumes(), client.listPrimaryIps(), client.listSnapshots(), client.pricing(),
  ]);

  for (const server of list) {
    const cost = serverCost({ server, volumes, primaryIps, snapshots, pricing, now });
    const metrics = await client.metrics(server.id, new Date(now.getTime() - DAY), now)
      .then((m) => ({ from: new Date(now.getTime() - DAY).toISOString(), ...m }))
      .catch(() => null); // a metrics hiccup is not a sync failure

    const values = {
      name: server.name, serverType: server.serverType, location: server.location, ipv4: server.ipv4, status: server.status,
      deleteProtected: server.deleteProtected, backupsEnabled: server.backupsEnabled,
      includedTrafficBytes: server.includedTrafficBytes, outgoingTrafficBytes: server.outgoingTrafficBytes,
      cost, ...(metrics ? { metrics } : {}), hetznerCreatedAt: server.createdAt, seenAt: now, updatedAt: now,
    };
    const [row] = await db.insert(schema.servers)
      .values({ organisationId, connectionId, hetznerId: server.id, ...values })
      .onConflictDoUpdate({ target: [schema.servers.organisationId, schema.servers.connectionId, schema.servers.hetznerId], set: values })
      .returning();

    await settlePendingAction(db, organisationId, row!, client, now);

    await upsertServerCost(db, organisationId, `${connectionId}:${server.id}`, `Hetzner — ${server.name} (${server.serverType.toUpperCase()})`, cost.projectedMonth, row!.business, label, now);
  }

  // Snapshots of servers that no longer exist still bill. One account-level line.
  const liveIds = new Set(list.map((s) => s.id));
  const orphanCents = Math.round(snapshots.filter((s) => s.createdFrom === null || !liveIds.has(s.createdFrom))
    .reduce((a, s) => a + s.sizeGb * pricing.imageMilliCentsPerGbMonth, 0) / 1000);
  const orphanId = `${connectionId}:orphan-snapshots`;
  if (orphanCents > 0) {
    await upsertServerCost(db, organisationId, orphanId, `Hetzner — snapshots of deleted servers (${label})`, orphanCents, "shared", label, now);
  }
  // A server gone from Hetzner (or no orphaned snapshots left) stops billing.
  const seen = [...list.map((s) => `${connectionId}:${s.id}`), ...(orphanCents > 0 ? [orphanId] : [])];
  await cancelSyncedCosts(db, organisationId, connectionId, seen, now);
  return list.length;
}

type ServerRow = typeof schema.servers.$inferSelect;

/**
 * Clears a server's `pending_action` once Hetzner says it has finished, or
 * once it is stale. Called by the sync for every server, and by
 * `settlePendingActions` on each /servers load so a finished reboot does not
 * read "Rebooting…" until the next 15-minute sync.
 */
export async function settlePendingAction(db: Db, organisationId: string, row: Pick<ServerRow, "id" | "pendingAction">, client: HetznerClient, now: Date) {
  const pending = row.pendingAction;
  if (!pending) return;
  const age = now.getTime() - new Date(pending.startedAt).getTime();
  let done: boolean;
  if (pending.id === 0) {
    // Still inside the claim window — leave it; clearing early would let
    // a second concurrent runServerAction fire the same action twice.
    done = age > CLAIM_PLACEHOLDER_GRACE_MS;
  } else if (age > PENDING_ACTION_STALE_MS) {
    done = true;
  } else {
    const action = await client.getAction(pending.id).catch(() => null);
    done = !!action && action.status !== "running";
  }
  if (!done) return;
  await db.update(schema.servers).set({ pendingAction: null })
    .where(and(eq(schema.servers.organisationId, organisationId), eq(schema.servers.id, row.id)));
}

/**
 * Settles every server with a real Hetzner action id (claim placeholders are
 * left to the sync), one client per account. Never throws: a revoked token
 * leaves its rows for the sync's staleness rule rather than breaking the page.
 */
export async function settlePendingActions(db: Db, organisationId: string, deps: InfraDeps & { now?: Date } = {}) {
  const now = deps.now ?? new Date();
  const rows = (await db.select({ id: schema.servers.id, connectionId: schema.servers.connectionId, pendingAction: schema.servers.pendingAction })
    .from(schema.servers)
    .where(and(eq(schema.servers.organisationId, organisationId), isNotNull(schema.servers.pendingAction))))
    .filter((r) => (r.pendingAction?.id ?? 0) > 0);
  for (const connectionId of new Set(rows.map((r) => r.connectionId))) {
    try {
      const client = hetznerFor(deps, await connectionSecret(db, organisationId, connectionId, deps.env));
      for (const row of rows.filter((r) => r.connectionId === connectionId)) {
        await settlePendingAction(db, organisationId, row, client, now);
      }
    } catch {
      // swallowed on purpose — see above; the sync reports account errors
    }
  }
}

async function upsertServerCost(db: Db, organisationId: string, externalId: string, name: string, cents: number, business: typeof schema.servers.$inferSelect["business"], account: string, now: Date) {
  const money = { name, status: "active", renewalPrice: cents, totalPrice: cents, currencyCode: "EUR", billingPeriod: 1, billingPeriodUnit: "month", business, seenAt: now, updatedAt: now };
  await db.insert(schema.supplierCosts)
    .values({ organisationId, supplier: "hetzner", source: "sync", externalId, vatTreatment: "reverse_charge", notes: `Synced from ${account}. List price, projected month.`, ...money })
    .onConflictDoUpdate({ target: [schema.supplierCosts.organisationId, schema.supplierCosts.supplier, schema.supplierCosts.externalId], set: money });
}

async function markConnection(db: Db, organisationId: string, id: string, error: string | null, now: Date) {
  await db.update(schema.infraConnections)
    .set(error ? { lastError: error.slice(0, 500) } : { lastError: null, lastSyncedAt: now })
    .where(and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, id)));
}

/** A Coolify on port 8000 of a server's public IP is that server's Coolify. Only fills blanks; never overrides a person. */
async function linkCoolifyByIp(db: Db, organisationId: string, connections: Awaited<ReturnType<typeof listConnections>>) {
  for (const c of connections.filter((c) => c.provider === "coolify" && !c.serverId && c.baseUrl)) {
    let host: string;
    try { host = new URL(c.baseUrl!).hostname; } catch { continue; }
    const [srv] = await db.select({ id: schema.servers.id }).from(schema.servers)
      .where(and(eq(schema.servers.organisationId, organisationId), eq(schema.servers.ipv4, host)));
    if (srv) {
      await db.update(schema.infraConnections).set({ serverId: srv.id })
        .where(and(eq(schema.infraConnections.id, c.id), isNull(schema.infraConnections.serverId)));
    }
  }
}
