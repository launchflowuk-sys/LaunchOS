import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectionSecret, createConnection, importConnectionsFromEnv, listConnections, removeConnection } from "./connections.js";

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
});
