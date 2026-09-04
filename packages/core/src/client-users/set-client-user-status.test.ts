import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createClientUser } from "./create-client-user.js";
import { listClientUsers } from "./list-client-users.js";
import { setClientUserStatus } from "./set-client-user-status.js";

async function newOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function newClient(db: Db, organisationId: string) {
  const [client] = await db.insert(schema.clients).values({ organisationId, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  return client!;
}

describe("setClientUserStatus", () => {
  it("suspends a portal account and reactivates it, keeping the user row", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const created = await createClientUser(db, org.id, {
        clientId: client.id, email: `portal-${crypto.randomUUID()}@client.test`, name: "Jo Client",
      });
      expect(created.clientUser.status).toBe("active");

      const suspended = await setClientUserStatus(db, org.id, {
        clientUserId: created.clientUser.id, status: "suspended", actorId: "staff-1",
      });
      expect(suspended.status).toBe("suspended");
      expect((await listClientUsers(db, org.id, client.id))[0]!.status).toBe("suspended");
      // The account it hangs off is untouched, so the audit trail's actor survives.
      const [user] = await db.select().from(schema.user).where(eq(schema.user.id, created.user.id));
      expect(user).toBeDefined();

      const back = await setClientUserStatus(db, org.id, {
        clientUserId: created.clientUser.id, status: "active", actorId: "staff-1",
      });
      expect(back.status).toBe("active");
    });
  });

  it("audits both directions", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const created = await createClientUser(db, org.id, {
        clientId: client.id, email: `portal-${crypto.randomUUID()}@client.test`, name: "Jo Client",
      });

      await setClientUserStatus(db, org.id, { clientUserId: created.clientUser.id, status: "suspended" });
      await setClientUserStatus(db, org.id, { clientUserId: created.clientUser.id, status: "active" });

      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.targetId, created.clientUser.id)));
      expect(rows.map((r) => r.action).sort()).toEqual([
        "client_user.created",
        "client_user.reactivated",
        "client_user.suspended",
      ]);
    });
  });

  it("refuses a client_user id from another organisation", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const other = await newOrg(db);
      const client = await newClient(db, org.id);
      const created = await createClientUser(db, org.id, {
        clientId: client.id, email: `portal-${crypto.randomUUID()}@client.test`, name: "Jo Client",
      });

      await expect(
        setClientUserStatus(db, other.id, { clientUserId: created.clientUser.id, status: "suspended" }),
      ).rejects.toThrow(/not found in organisation/);
    });
  });
});
