import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { listActivity } from "./list-activity.js";
import { recordActivity } from "./record-activity.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

// Inserted directly rather than through createClient: this task lands before
// the client service learns about slugs.
async function makeClient(db: Db, organisationId: string) {
  const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const [client] = await db.insert(schema.clients).values({ organisationId, name: "Acme", slug }).returning();
  return client!;
}

describe("recordActivity", () => {
  // Both calls land in the same withTestDb transaction, and Postgres `now()`
  // (hence `defaultNow()`) is fixed for a transaction's lifetime, so the two
  // events can share an identical `createdAt` — asserting strict order between
  // them would depend on the `id` tie-break in listActivity, which is a random
  // UUID unrelated to insertion order. Assert set membership instead.
  it("records events for a client and refuses another organisation's client", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);
      const client = await makeClient(db, orgA.id);

      await recordActivity(db, orgA.id, { clientId: client.id, kind: "client.created", title: "Client created" });
      await recordActivity(db, orgA.id, {
        clientId: client.id, actorKind: "user", actorId: "u1", kind: "contact.added", title: "Contact added", link: `/clients/${client.id}`,
      });

      const events = await listActivity(db, orgA.id, { clientId: client.id });
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.kind))).toEqual(new Set(["contact.added", "client.created"]));
      expect(events.find((e) => e.kind === "contact.added")?.actorKind).toBe("user");
      expect(events.find((e) => e.kind === "client.created")?.actorKind).toBe("system");

      await expect(
        recordActivity(db, orgB.id, { clientId: client.id, kind: "x", title: "y" }),
      ).rejects.toThrow(`client ${client.id} not found in organisation`);
    });
  });
});
