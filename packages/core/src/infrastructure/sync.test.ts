import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MOCK_SERVERS, mockCoolifyInstanceClient, mockHetznerClient } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connections.js";
import { settlePendingActions, syncInfrastructure } from "./sync.js";

const env = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const now = new Date("2026-09-25T12:00:00Z");
async function org(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  return o!;
}

describe("syncInfrastructure", () => {
  it("upserts servers and one supplier_costs row per server", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      const out = await syncInfrastructure(db, o.id, { env, now });
      expect(out.servers).toBe(2);
      const costs = await db.select().from(schema.supplierCosts).where(and(eq(schema.supplierCosts.organisationId, o.id), eq(schema.supplierCosts.supplier, "hetzner")));
      expect(costs).toHaveLength(2);
      expect(costs[0]).toMatchObject({ source: "sync", currencyCode: "EUR", vatTreatment: "reverse_charge", billingPeriodUnit: "month", business: "shared" });
      const pizza = costs.find((c) => c.name.includes("mock-pizza"))!;
      expect(pizza.renewalPrice).toBe(549 + 572 + 50); // base + 100 GB volume + IPv4
      await syncInfrastructure(db, o.id, { env, now });
      expect(await db.select().from(schema.servers).where(eq(schema.servers.organisationId, o.id))).toHaveLength(2);
    });
  });

  it("cancels the cost row of a server that disappears, and reactivates it when it returns", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      const conn = await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const onlyFirst = () => mockHetznerClient({ servers: [MOCK_SERVERS[0]!] });
      await syncInfrastructure(db, o.id, { env, now: new Date(now.getTime() + 60_000), hetzner: onlyFirst });
      const byId = async () => new Map((await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.organisationId, o.id))).map((c) => [c.externalId, c.status]));
      let rows = await byId();
      expect(rows.get(`${conn.id}:1`)).toBe("active");
      expect(rows.get(`${conn.id}:2`)).toBe("cancelled");
      await syncInfrastructure(db, o.id, { env, now: new Date(now.getTime() + 120_000) });
      rows = await byId();
      expect(rows.get(`${conn.id}:2`)).toBe("active");
    });
  });

  it("cancels the orphan-snapshots line once there is nothing orphaned", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      const conn = await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      const orphaned = () => mockHetznerClient({ snapshots: [{ id: 99, sizeGb: 100, createdFrom: 777, description: "old" }] });
      await syncInfrastructure(db, o.id, { env, now, hetzner: orphaned });
      const line = async () => (await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.externalId, `${conn.id}:orphan-snapshots`)))[0];
      expect((await line())!.status).toBe("active");
      await syncInfrastructure(db, o.id, { env, now });
      expect((await line())!.status).toBe("cancelled");
    });
  });

  it("never overwrites the business a person set, and copies it to the cost row", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      await db.update(schema.servers).set({ business: "cabio" }).where(eq(schema.servers.name, "mock-cabio"));
      await syncInfrastructure(db, o.id, { env, now });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.name, "mock-cabio"));
      expect(s!.business).toBe("cabio");
      const [c] = await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.externalId, `${s!.connectionId}:${s!.hetznerId}`));
      expect(c!.business).toBe("cabio");
    });
  });

  it("never overwrites notes a person set on a synced cost row", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      await db.update(schema.supplierCosts).set({ notes: "mine" }).where(and(eq(schema.supplierCosts.organisationId, o.id), eq(schema.supplierCosts.supplier, "hetzner")));
      await syncInfrastructure(db, o.id, { env, now });
      const rows = await db.select().from(schema.supplierCosts).where(and(eq(schema.supplierCosts.organisationId, o.id), eq(schema.supplierCosts.supplier, "hetzner")));
      expect(rows.every((r) => r.notes === "mine")).toBe(true);
    });
  });

  it("one failing connection does not stop the others and records its error", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      const good = await createConnection(db, o.id, { provider: "hetzner_cloud", label: "Good", token: "mock_1", actorId: "u" }, { env });
      const bad = await createConnection(db, o.id, { provider: "hetzner_cloud", label: "Bad", token: "mock_2", actorId: "u" }, { env });
      const hetzner = (token: string) => {
        if (token === "mock_2") return { ...mockHetznerClient(), listServers: async () => { throw new Error("boom"); } };
        return mockHetznerClient();
      };
      const out = await syncInfrastructure(db, o.id, { env, now, hetzner });
      expect(out.connections.find((c) => c.label === "Bad")).toMatchObject({ ok: false, error: "boom" });
      const [b] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, bad.id));
      const [g] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, good.id));
      expect(b!.lastError).toBe("boom");
      expect(g!.lastError).toBeNull();
      expect(g!.lastSyncedAt).not.toBeNull();
    });
  });

  it("checks each Coolify connection's reachability on its own", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      const good = await createConnection(db, o.id, { provider: "coolify", label: "Good", baseUrl: "http://10.9.0.1:8000", token: "mock_g", actorId: "u" }, { env });
      const bad = await createConnection(db, o.id, { provider: "coolify", label: "Bad", baseUrl: "http://10.9.0.9:8000", token: "mock_b", actorId: "u" }, { env });
      const coolify = (url: string, token: string) => {
        if (url.includes("10.9.0.9")) return { ...mockCoolifyInstanceClient(), version: async () => { throw new Error("connect ECONNREFUSED"); } };
        expect(token).toBe("mock_g");
        return mockCoolifyInstanceClient();
      };
      const out = await syncInfrastructure(db, o.id, { env, now, coolify });
      expect(out.connections).toEqual(expect.arrayContaining([{ label: "Good", ok: true }, { label: "Bad", ok: false, error: "connect ECONNREFUSED" }]));
      const [g] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, good.id));
      const [b] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, bad.id));
      expect(g).toMatchObject({ lastError: null, lastSyncedAt: now });
      expect(b).toMatchObject({ lastError: "connect ECONNREFUSED", lastSyncedAt: null });
    });
  });

  it("links a Coolify connection to the server whose IPv4 is its URL host", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      const c = await createConnection(db, o.id, { provider: "coolify", label: "C", baseUrl: "http://10.9.0.2:8000", token: "mock_c", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const [row] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, c.id));
      const [pizza] = await db.select().from(schema.servers).where(eq(schema.servers.ipv4, "10.9.0.2"));
      expect(row!.serverId).toBe(pizza!.id);
    });
  });

  it("settles a pending action", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const client = mockHetznerClient();
      const a = await client.runAction(1, "reboot");
      await db.update(schema.servers).set({ pendingAction: { id: a.id, command: "reboot", startedAt: now.toISOString() } }).where(eq(schema.servers.hetznerId, 1));
      await syncInfrastructure(db, o.id, { env, now, hetzner: () => client });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.hetznerId, 1));
      expect(s!.pendingAction).toBeNull();
    });
  });

  it("settlePendingActions settles finished actions without a full sync, one client per connection", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const startedAt = now.toISOString();
      await db.update(schema.servers).set({ pendingAction: { id: 7, command: "reboot", startedAt } }).where(and(eq(schema.servers.organisationId, o.id), eq(schema.servers.hetznerId, 1)));
      await db.update(schema.servers).set({ pendingAction: { id: 8, command: "poweron", startedAt } }).where(and(eq(schema.servers.organisationId, o.id), eq(schema.servers.hetznerId, 2)));
      let clients = 0;
      const hetzner = () => {
        clients += 1;
        return { ...mockHetznerClient(), listServers: async () => { throw new Error("must not list"); }, getAction: async (id: number) => ({ id, status: id === 7 ? ("success" as const) : ("running" as const), error: null }) };
      };
      await settlePendingActions(db, o.id, { env, now, hetzner });
      expect(clients).toBe(1);
      const rows = await db.select().from(schema.servers).where(eq(schema.servers.organisationId, o.id));
      expect(rows.find((s) => s.hetznerId === 1)!.pendingAction).toBeNull();
      expect(rows.find((s) => s.hetznerId === 2)!.pendingAction).toMatchObject({ id: 8 });
    });
  });

  it("settlePendingActions leaves a claim placeholder alone and makes no provider call when nothing is pending", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      let clients = 0;
      const hetzner = () => { clients += 1; return mockHetznerClient(); };
      await settlePendingActions(db, o.id, { env, now, hetzner });
      expect(clients).toBe(0);
      await db.update(schema.servers).set({ pendingAction: { id: 0, command: "reboot", startedAt: now.toISOString() } }).where(and(eq(schema.servers.organisationId, o.id), eq(schema.servers.hetznerId, 1)));
      await settlePendingActions(db, o.id, { env, now, hetzner });
      expect(clients).toBe(0);
      const [s] = await db.select().from(schema.servers).where(and(eq(schema.servers.organisationId, o.id), eq(schema.servers.hetznerId, 1)));
      expect(s!.pendingAction).toMatchObject({ id: 0 });
    });
  });

  it("clears a claim placeholder (id 0) started 3 minutes ago even when getAction throws", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const startedAt = new Date(now.getTime() - 3 * 60_000).toISOString();
      await db.update(schema.servers).set({ pendingAction: { id: 0, command: "reboot", startedAt } }).where(eq(schema.servers.hetznerId, 1));
      const throwing = () => ({ ...mockHetznerClient(), getAction: async () => { throw new Error("no such action"); } });
      await syncInfrastructure(db, o.id, { env, now, hetzner: throwing });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.hetznerId, 1));
      expect(s!.pendingAction).toBeNull();
    });
  });

  it("keeps a fresh claim placeholder (id 0, started just now) — a concurrent runServerAction is still mid-flight", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      await db.update(schema.servers).set({ pendingAction: { id: 0, command: "reboot", startedAt: now.toISOString() } }).where(eq(schema.servers.hetznerId, 1));
      await syncInfrastructure(db, o.id, { env, now });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.hetznerId, 1));
      expect(s!.pendingAction).toMatchObject({ id: 0, command: "reboot" });
    });
  });

  it("clears a real action id started 20 minutes ago when getAction throws", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const startedAt = new Date(now.getTime() - 20 * 60_000).toISOString();
      await db.update(schema.servers).set({ pendingAction: { id: 4242, command: "reboot", startedAt } }).where(eq(schema.servers.hetznerId, 1));
      const throwing = () => ({ ...mockHetznerClient(), getAction: async () => { throw new Error("revoked token"); } });
      await syncInfrastructure(db, o.id, { env, now, hetzner: throwing });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.hetznerId, 1));
      expect(s!.pendingAction).toBeNull();
    });
  });

  it("keeps a real action id started 1 minute ago when getAction throws", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const startedAt = new Date(now.getTime() - 60_000).toISOString();
      await db.update(schema.servers).set({ pendingAction: { id: 4242, command: "reboot", startedAt } }).where(eq(schema.servers.hetznerId, 1));
      const throwing = () => ({ ...mockHetznerClient(), getAction: async () => { throw new Error("timeout"); } });
      await syncInfrastructure(db, o.id, { env, now, hetzner: throwing });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.hetznerId, 1));
      expect(s!.pendingAction).toMatchObject({ id: 4242, command: "reboot" });
    });
  });
});
