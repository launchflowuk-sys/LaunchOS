import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectionSecret, createConnection, importConnectionsFromEnv, listConnections, listServerOptions, removeConnection, updateConnection } from "./connections.js";
import { syncInfrastructure } from "./sync.js";

const env = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const deps = { env };
async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("connections", () => {
  it("stores the token encrypted and never returns it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "Hetzner A", token: "mock_abc", actorId: "u1" }, deps);
      expect(JSON.stringify(row)).not.toContain("mock_abc");
      const [raw] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, row.id));
      expect(raw!.tokenEncrypted).not.toContain("mock_abc");
      expect(await connectionSecret(db, org.id, row.id, env)).toBe("mock_abc");
    });
  });

  it("refuses to save a token the provider rejects", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const rejecting = { ...deps, hetzner: () => ({ listServers: async () => { throw new Error("The provider refused the token (HTTP 401)."); } }) as never };
      await expect(createConnection(db, org.id, { provider: "hetzner_cloud", label: "Bad", token: "x", actorId: "u1" }, rejecting)).rejects.toThrow(/refused/);
      expect(await listConnections(db, org.id)).toHaveLength(0);
    });
  });

  it("requires a base URL for Coolify", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await expect(createConnection(db, org.id, { provider: "coolify", label: "C", token: "mock_x", actorId: "u1" }, deps)).rejects.toThrow(/URL/);
    });
  });

  it("is scoped to its organisation", async () => {
    await withTestDb(async (db) => {
      const a = await makeOrg(db); const b = await makeOrg(db);
      const row = await createConnection(db, a.id, { provider: "hetzner_cloud", label: "A", token: "mock_a", actorId: "u1" }, deps);
      expect(await listConnections(db, b.id)).toHaveLength(0);
      await expect(connectionSecret(db, b.id, row.id, env)).rejects.toThrow();
      await removeConnection(db, b.id, { id: row.id, actorId: "u1" });
      expect(await listConnections(db, a.id)).toHaveLength(1);
    });
  });

  it("writes audit rows for create and remove, without the token", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "A", token: "mock_secret", actorId: "u1" }, deps);
      await removeConnection(db, org.id, { id: row.id, actorId: "u1" });
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, row.id));
      expect(audits.map((a) => a.action).sort()).toEqual(["infra.connection.create", "infra.connection.remove"]);
      expect(JSON.stringify(audits)).not.toContain("mock_secret");
    });
  });

  it("cancels the removed connection's synced cost rows, and only those", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const gone = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "A", token: "mock_a", actorId: "u1" }, deps);
      const kept = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "B", token: "mock_b", actorId: "u1" }, deps);
      await syncInfrastructure(db, org.id, deps);
      await removeConnection(db, org.id, { id: gone.id, actorId: "u1" });
      const rows = await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.organisationId, org.id));
      const statusOf = (connId: string) => rows.filter((r) => r.externalId?.startsWith(`${connId}:`)).map((r) => r.status);
      expect(statusOf(gone.id)).toEqual(["cancelled", "cancelled"]);
      expect(statusOf(kept.id)).toEqual(["active", "active"]);
    });
  });

  it("imports Hetzner and Coolify tokens from env, splitting Coolify on the first | only", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const envFile = {
        ...env,
        HETZNER_API_TOKENS: "mock_h1,mock_h2",
        COOLIFY_CABIOMASTER: "http://10.9.0.1:8000|mock_7|abc",
        COOLIFY_EMPTY: "http://10.9.0.9:8000|",
      };
      const out = await importConnectionsFromEnv(db, org.id, envFile, "u1", { env });
      expect(out.added.sort()).toEqual(["Coolify — CABIOMASTER", "Hetzner — account 1", "Hetzner — account 2"]);
      expect(out.skipped).toEqual(["Coolify — EMPTY"]);
      const again = await importConnectionsFromEnv(db, org.id, envFile, "u1", { env });
      expect(again.added).toEqual([]); // label is unique; re-import is a no-op
    });
  });

  it("ignores unrelated COOLIFY_* env keys during import", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const envFile = {
        ...env,
        COOLIFY_API_URL: "https://x.test",
        COOLIFY_API_TOKEN: "abc",
      };
      const out = await importConnectionsFromEnv(db, org.id, envFile, "u1", { env });
      expect(out.added).toEqual([]);
      expect(out.skipped).toEqual([]);
    });
  });

  it("rejects a serverId belonging to another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await makeOrg(db);
      const b = await makeOrg(db);
      const rowA = await createConnection(db, a.id, { provider: "hetzner_cloud", label: "A", token: "mock_a", actorId: "u1" }, deps);
      const rowB = await createConnection(db, b.id, { provider: "hetzner_cloud", label: "B", token: "mock_b", actorId: "u1" }, deps);
      const [serverB] = await db
        .insert(schema.servers)
        .values({
          organisationId: b.id,
          connectionId: rowB.id,
          hetznerId: 1,
          name: "srv-b",
          serverType: "cx23",
          location: "fsn1",
          status: "running",
          hetznerCreatedAt: new Date(),
        })
        .returning();
      await expect(updateConnection(db, a.id, { id: rowA.id, serverId: serverB!.id, actorId: "u1" }, deps)).rejects.toThrow(/Server not found/);
    });
  });

  it("leaves the stored secret unchanged when a replacement token is rejected", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "A", token: "mock_good", actorId: "u1" }, deps);
      const rejecting = { ...deps, hetzner: () => ({ listServers: async () => { throw new Error("The provider refused the token (HTTP 401)."); } }) as never };
      await expect(updateConnection(db, org.id, { id: row.id, token: "mock_bad", actorId: "u1" }, rejecting)).rejects.toThrow(/refused/);
      expect(await connectionSecret(db, org.id, row.id, env)).toBe("mock_good");
    });
  });

  it("swaps the token and records tokenReplaced without plaintext", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "A", token: "mock_old", actorId: "u1" }, deps);
      await updateConnection(db, org.id, { id: row.id, token: "mock_new", actorId: "u1" }, deps);
      expect(await connectionSecret(db, org.id, row.id, env)).toBe("mock_new");
      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.targetId, row.id), eq(schema.auditLog.action, "infra.connection.update")));
      expect((audits[0]!.after as { tokenReplaced: boolean }).tokenReplaced).toBe(true);
      expect(JSON.stringify(audits)).not.toContain("mock_new");
      expect(JSON.stringify(audits)).not.toContain("mock_old");
    });
  });

  it("refuses a Coolify baseUrl change the provider rejects, leaving the stored URL unchanged", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(
        db,
        org.id,
        { provider: "coolify", label: "C", baseUrl: "http://good:8000", token: "mock_x", actorId: "u1" },
        deps,
      );
      const rejecting = {
        ...deps,
        coolify: () => ({
          version: async () => {
            throw new Error("The provider refused the token (HTTP 401).");
          },
          resources: async () => [],
          deploy: async () => ({ deploymentUuid: null }),
        }) as never,
      };
      await expect(
        updateConnection(db, org.id, { id: row.id, baseUrl: "http://evil:8000", actorId: "u1" }, rejecting),
      ).rejects.toThrow(/refused/);
      const [again] = await listConnections(db, org.id);
      expect(again!.baseUrl).toBe("http://good:8000");
    });
  });

  it("refuses to null out a Coolify baseUrl", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(
        db,
        org.id,
        { provider: "coolify", label: "C", baseUrl: "http://good:8000", token: "mock_x", actorId: "u1" },
        deps,
      );
      await expect(updateConnection(db, org.id, { id: row.id, baseUrl: null, actorId: "u1" }, deps)).rejects.toThrow(/URL/);
      const [again] = await listConnections(db, org.id);
      expect(again!.baseUrl).toBe("http://good:8000");
    });
  });

  it("lists server options tenancy-filtered", async () => {
    await withTestDb(async (db) => {
      const a = await makeOrg(db);
      const b = await makeOrg(db);
      await createConnection(db, a.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u1" }, deps);
      await syncInfrastructure(db, a.id, deps);
      const optionsA = await listServerOptions(db, a.id);
      expect(optionsA.length).toBeGreaterThan(0);
      expect(optionsA[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
      expect(await listServerOptions(db, b.id)).toEqual([]);
    });
  });
});
