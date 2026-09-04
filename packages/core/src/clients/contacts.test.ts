import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "./create-client.js";
import { createContact, deleteContact, listContacts, updateContact } from "./contacts.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("client contacts", () => {
  it("keeps exactly one primary contact and lists it first", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });

      const first = await createContact(db, org.id, {
        clientId: client.id, name: "Zoe", email: `zoe-${crypto.randomUUID()}@acme.test`, isPrimary: true,
      });
      const second = await createContact(db, org.id, {
        clientId: client.id, name: "Adam", phone: "07000 000000", isPrimary: true,
      });

      const contacts = await listContacts(db, org.id, client.id);
      expect(contacts.map((c) => c.name)).toEqual(["Adam", "Zoe"]);
      expect(contacts.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([second.id]);

      await updateContact(db, org.id, { contactId: first.id, role: "Owner", isPrimary: true });
      const after = await listContacts(db, org.id, client.id);
      expect(after.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([first.id]);

      await deleteContact(db, org.id, { contactId: second.id });
      expect(await listContacts(db, org.id, client.id)).toHaveLength(1);
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const client = await createClient(db, orgA.id, { name: "Acme" });
      await expect(createContact(db, orgB.id, { clientId: client.id, name: "Mallory" })).rejects.toThrow(
        `client ${client.id} not found in organisation`,
      );
    });
  });
});
