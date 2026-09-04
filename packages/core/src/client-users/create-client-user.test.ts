import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createClientUser } from "./create-client-user.js";

async function newOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function newClient(db: Db, organisationId: string) {
  const [client] = await db.insert(schema.clients).values({ organisationId, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  return client!;
}

describe("createClientUser", () => {
  it("(d) creates a Better Auth user with a credential account and links it to the client", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `portal-${crypto.randomUUID()}@client.test`;

      const result = await createClientUser(db, org.id, { clientId: client.id, email, name: "Jo Client" });

      expect(result.oneTimePassword).toHaveLength(16);
      expect(result.user.email).toBe(email);
      expect(result.clientUser.clientId).toBe(client.id);
      expect(result.clientUser.role).toBe("client_member");
      const [account] = await db.select().from(schema.account).where(eq(schema.account.userId, result.user.id));
      expect(account!.providerId).toBe("credential");
      expect(account!.password).not.toContain(result.oneTimePassword);
    });
  });

  it("(a) refuses an email that already has a credential account", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `portal-${crypto.randomUUID()}@client.test`;
      await createClientUser(db, org.id, { clientId: client.id, email, name: "Jo" });

      await expect(createClientUser(db, org.id, { clientId: client.id, email, name: "Jo" })).rejects.toThrow(/already registered/i);
    });
  });

  it("refuses to invite the same email twice for one client (still an 'already' error)", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `portal-${crypto.randomUUID()}@client.test`;
      await createClientUser(db, org.id, { clientId: client.id, email, name: "Jo" });
      await expect(createClientUser(db, org.id, { clientId: client.id, email, name: "Jo" })).rejects.toThrow(/already/i);
    });
  });

  it("(b) refuses an email that belongs to a staff member of this organisation, even without a credential yet", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `staff-${crypto.randomUUID()}@agency.test`;

      // A pending staff invite: a user + organisation_members row with no
      // credential account yet, mirroring what create-member.ts leaves for an
      // invited-but-not-yet-signed-in member.
      const [staffUser] = await db.insert(schema.user).values({ id: randomUUID(), name: "Staffer", email, emailVerified: true }).returning();
      await db.insert(schema.organisationMembers).values({
        organisationId: org.id, userId: staffUser!.id, displayName: "Staffer", role: "staff", status: "invited",
      });

      await expect(
        createClientUser(db, org.id, { clientId: client.id, email, name: "Staffer" }),
      ).rejects.toThrow(/staff accounts cannot be client users/i);

      const [link] = await db.select().from(schema.clientUsers).where(eq(schema.clientUsers.userId, staffUser!.id));
      expect(link).toBeUndefined();
    });
  });

  it("(c) issues a credential and links an existing Better Auth user who has no credential and is not staff", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `preexisting-${crypto.randomUUID()}@client.test`;
      const [existingUser] = await db.insert(schema.user).values({ id: randomUUID(), name: "Pre Existing", email, emailVerified: true }).returning();

      const result = await createClientUser(db, org.id, { clientId: client.id, email, name: "Pre Existing" });

      expect(result.user.id).toBe(existingUser!.id);
      const [account] = await db.select().from(schema.account).where(eq(schema.account.userId, existingUser!.id));
      expect(account!.providerId).toBe("credential");
      expect(result.clientUser.userId).toBe(existingUser!.id);
    });
  });

  it("persists an explicitly chosen role", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `portal-${crypto.randomUUID()}@client.test`;

      const result = await createClientUser(db, org.id, { clientId: client.id, email, name: "Jo", role: "client_admin" });

      expect(result.clientUser.role).toBe("client_admin");
      const [row] = await db
        .select()
        .from(schema.clientUsers)
        .where(and(eq(schema.clientUsers.clientId, client.id), eq(schema.clientUsers.userId, result.user.id)));
      expect(row!.role).toBe("client_admin");
    });
  });

  it("defaults to the client_member role when none is given", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `portal-${crypto.randomUUID()}@client.test`;

      const result = await createClientUser(db, org.id, { clientId: client.id, email, name: "Jo" });

      expect(result.clientUser.role).toBe("client_member");
    });
  });

  it("refuses a client id from another organisation", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const otherOrg = await newOrg(db);
      const otherClient = await newClient(db, otherOrg.id);
      const email = `portal-${crypto.randomUUID()}@client.test`;

      await expect(
        createClientUser(db, org.id, { clientId: otherClient.id, email, name: "Jo" }),
      ).rejects.toThrow(/not found in organisation/i);
    });
  });
});
