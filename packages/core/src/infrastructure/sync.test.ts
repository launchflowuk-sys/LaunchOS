import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { mockHetznerClient } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connections.js";
import { syncInfrastructure } from "./sync.js";

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
});
