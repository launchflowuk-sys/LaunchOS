import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connections.js";
import { redeployApp, runServerAction, setServerBusiness } from "./actions.js";
import { syncInfrastructure } from "./sync.js";

const env = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
async function seeded(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  await createConnection(db, o!.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
  await syncInfrastructure(db, o!.id, { env });
  const [s] = await db.select().from(schema.servers).where(eq(schema.servers.name, "mock-pizza"));
  return { org: o!, server: s! };
}

describe("runServerAction", () => {
  it("requires the typed server name for reboot and shutdown", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      await expect(runServerAction(db, org.id, { serverId: server.id, command: "reboot", confirmName: "wrong", actorId: "u" }, { env })).rejects.toThrow(/name/);
    });
  });

  it("runs, stores the pending action and audits it", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      const out = await runServerAction(db, org.id, { serverId: server.id, command: "reboot", confirmName: "mock-pizza", actorId: "u" }, { env });
      const [after] = await db.select().from(schema.servers).where(eq(schema.servers.id, server.id));
      expect(after!.pendingAction).toMatchObject({ id: out.actionId, command: "reboot" });
      const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "infra.server.reboot"));
      expect(audit).toMatchObject({ targetType: "server", targetId: server.id, actorId: "u" });
    });
  });

  it("refuses a second action while one is running", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      await runServerAction(db, org.id, { serverId: server.id, command: "poweron", actorId: "u" }, { env });
      await expect(runServerAction(db, org.id, { serverId: server.id, command: "poweron", actorId: "u" }, { env })).rejects.toThrow(/already/);
    });
  });

  it("cannot touch another organisation's server", async () => {
    await withTestDb(async (db) => {
      const { server } = await seeded(db);
      const [other] = await db.insert(schema.organisations).values({ name: "X", slug: `x-${crypto.randomUUID()}` }).returning();
      await expect(runServerAction(db, other!.id, { serverId: server.id, command: "poweron", actorId: "u" }, { env })).rejects.toThrow(/not found/);
    });
  });

  it("leaves pending_action null and writes no audit row when the provider rejects the action", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      const rejecting = { env, hetzner: () => ({ runAction: async () => { throw new Error("Hetzner said no."); } }) as never };
      await expect(runServerAction(db, org.id, { serverId: server.id, command: "poweron", actorId: "u" }, rejecting)).rejects.toThrow("Hetzner said no.");
      const [after] = await db.select().from(schema.servers).where(eq(schema.servers.id, server.id));
      expect(after!.pendingAction).toBeNull();
      const auditRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "infra.server.poweron"));
      expect(auditRows).toHaveLength(0);
    });
  });
});

describe("setServerBusiness", () => {
  it("tags the server, the cost row follows, and it is audited", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      await setServerBusiness(db, org.id, { serverId: server.id, business: "launchflow", actorId: "u" });
      const [c] = await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.externalId, `${server.connectionId}:${server.hetznerId}`));
      expect(c!.business).toBe("launchflow");
      const [a] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "infra.server.business"));
      expect(a!.before).toEqual({ business: "shared" });
    });
  });
});

describe("redeployApp", () => {
  it("deploys through the connection and audits it", async () => {
    await withTestDb(async (db) => {
      const { org } = await seeded(db);
      const c = await createConnection(db, org.id, { provider: "coolify", label: "C", baseUrl: "http://10.9.0.2:8000", token: "mock_c", actorId: "u" }, { env });
      const out = await redeployApp(db, org.id, { connectionId: c.id, appUuid: "mock-app", appName: "mock-web", actorId: "u" }, { env });
      expect(out.deploymentUuid).toBe("mock-deployment");
      const [a] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "infra.app.redeploy"));
      expect(a!.after).toMatchObject({ appUuid: "mock-app", appName: "mock-web" });
    });
  });

  it("refuses a Hetzner connection id", async () => {
    await withTestDb(async (db) => {
      const { org } = await seeded(db);
      const [hetznerConn] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.organisationId, org.id));
      await expect(redeployApp(db, org.id, { connectionId: hetznerConn!.id, appUuid: "mock-app", appName: "mock-web", actorId: "u" }, { env })).rejects.toThrow(/not found/);
    });
  });

  it("refuses another organisation's Coolify connection id", async () => {
    await withTestDb(async (db) => {
      const { org } = await seeded(db);
      const c = await createConnection(db, org.id, { provider: "coolify", label: "C", baseUrl: "http://10.9.0.2:8000", token: "mock_c", actorId: "u" }, { env });
      const [other] = await db.insert(schema.organisations).values({ name: "X", slug: `x-${crypto.randomUUID()}` }).returning();
      await expect(redeployApp(db, other!.id, { connectionId: c.id, appUuid: "mock-app", appName: "mock-web", actorId: "u" }, { env })).rejects.toThrow(/not found/);
    });
  });
});
