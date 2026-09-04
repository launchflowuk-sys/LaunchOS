import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClientUser } from "./create-client-user.js";

describe("createClientUser", () => {
  it("creates a Better Auth user with a credential account and links it to the client", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const email = `portal-${crypto.randomUUID()}@client.test`;

      const result = await createClientUser(db, org!.id, { clientId: client!.id, email, name: "Jo Client" });

      expect(result.oneTimePassword).toHaveLength(16);
      expect(result.user.email).toBe(email);
      expect(result.clientUser.clientId).toBe(client!.id);
      const [account] = await db.select().from(schema.account).where(eq(schema.account.userId, result.user.id));
      expect(account!.providerId).toBe("credential");
      expect(account!.password).not.toContain(result.oneTimePassword);
    });
  });

  it("refuses to invite the same email twice for one client", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
      const email = `portal-${crypto.randomUUID()}@client.test`;
      await createClientUser(db, org!.id, { clientId: client!.id, email, name: "Jo" });
      await expect(createClientUser(db, org!.id, { clientId: client!.id, email, name: "Jo" })).rejects.toThrow(/already/i);
    });
  });

  it("refuses a client id from another organisation", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const [otherOrg] = await db.insert(schema.organisations).values({ name: "O", slug: `o-${crypto.randomUUID()}` }).returning();
      const [otherClient] = await db.insert(schema.clients).values({ organisationId: otherOrg!.id, name: "C2", slug: `c2-${crypto.randomUUID()}` }).returning();
      const email = `portal-${crypto.randomUUID()}@client.test`;

      await expect(
        createClientUser(db, org!.id, { clientId: otherClient!.id, email, name: "Jo" }),
      ).rejects.toThrow(/not found in organisation/i);
    });
  });
});
