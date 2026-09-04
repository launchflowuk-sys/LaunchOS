import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClientUser } from "./create-client-user.js";
import { listClientUsers } from "./list-client-users.js";

async function newOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function newClient(db: Db, organisationId: string) {
  const [client] = await db.insert(schema.clients).values({ organisationId, name: "C", slug: `c-${crypto.randomUUID()}` }).returning();
  return client!;
}

describe("listClientUsers", () => {
  it("(d) returns this client's portal accounts with their name, email and role", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const client = await newClient(db, org.id);
      const email = `portal-${crypto.randomUUID()}@client.test`;
      await createClientUser(db, org.id, { clientId: client.id, email, name: "Jo Client", role: "client_admin" });

      const rows = await listClientUsers(db, org.id, client.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email, name: "Jo Client", role: "client_admin" });
    });
  });

  it("(a) never returns another client's or another organisation's portal accounts", async () => {
    await withTestDb(async (db) => {
      const org = await newOrg(db);
      const other = await newOrg(db);
      const client = await newClient(db, org.id);
      const sibling = await newClient(db, org.id);
      await createClientUser(db, org.id, {
        clientId: client.id, email: `portal-${crypto.randomUUID()}@client.test`, name: "Jo Client",
      });

      expect(await listClientUsers(db, org.id, sibling.id)).toEqual([]);
      // Same client id, wrong organisation: the tenant filter, not the client
      // filter, is what has to reject this.
      expect(await listClientUsers(db, other.id, client.id)).toEqual([]);
    });
  });
});
