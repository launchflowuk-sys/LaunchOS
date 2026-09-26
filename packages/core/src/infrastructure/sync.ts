import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { HetznerClient } from "@launchos/integrations";
import { and, eq, isNull } from "drizzle-orm";
import { connectionSecret, hetznerFor, listConnections, type InfraDeps } from "./connections.js";
import { serverCost } from "./cost.js";

const DAY = 86_400_000;

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

  for (const conn of connections.filter((c) => c.provider === "hetzner_cloud")) {
    try {
      const client = hetznerFor(deps, await connectionSecret(db, organisationId, conn.id, deps.env));
      serverCount += await syncHetznerAccount(db, organisationId, conn.id, conn.label, client, now);
      await markConnection(db, organisationId, conn.id, null, now);
      report.push({ label: conn.label, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markConnection(db, organisationId, conn.id, message, now);
      report.push({ label: conn.label, ok: false, error: message });
    }
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

    if (row!.pendingAction) {
      const action = await client.getAction(row!.pendingAction.id).catch(() => null);
      if (action && action.status !== "running") {
        await db.update(schema.servers).set({ pendingAction: null }).where(eq(schema.servers.id, row!.id));
      }
    }

    await upsertServerCost(db, organisationId, `${connectionId}:${server.id}`, `Hetzner — ${server.name} (${server.serverType.toUpperCase()})`, cost.projectedMonth, row!.business, label, now);
  }

  // Snapshots of servers that no longer exist still bill. One account-level line.
  const liveIds = new Set(list.map((s) => s.id));
  const orphanCents = Math.round(snapshots.filter((s) => s.createdFrom === null || !liveIds.has(s.createdFrom))
    .reduce((a, s) => a + s.sizeGb * pricing.imageMilliCentsPerGbMonth, 0) / 1000);
  if (orphanCents > 0) {
    await upsertServerCost(db, organisationId, `${connectionId}:orphan-snapshots`, `Hetzner — snapshots of deleted servers (${label})`, orphanCents, "shared", label, now);
  }
  return list.length;
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
