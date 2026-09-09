import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { ensureAgentsEnabled } from "./agent-enablement.js";

const quiet = { info: () => {} };

type TestDb = Parameters<typeof ensureAgentsEnabled>[0];

const org = (db: TestDb) =>
  db.insert(schema.organisations).values({ name: "T", slug: `test-${crypto.randomUUID()}` }).returning().then((r) => r[0]!);

/** What this organisation ended up with. The test database carries seeded
 *  organisations of its own, so every assertion here is scoped to one. */
async function enablementFor(db: TestDb, organisationId: string) {
  const rows = await db.select().from(schema.agentEnablement).where(eq(schema.agentEnablement.organisationId, organisationId));
  return Object.fromEntries(rows.map((r) => [r.agentKey, r.enabled]));
}

describe("ensureAgentsEnabled", () => {
  it("gives every registered agent a row in every organisation", async () => {
    await withTestDb(async (db) => {
      const a = await org(db);
      const b = await org(db);

      await ensureAgentsEnabled(db, ["one", "two"], quiet);

      expect(await enablementFor(db, a.id)).toEqual({ one: true, two: true });
      expect(await enablementFor(db, b.id)).toEqual({ one: true, two: true });
    });
  });

  // The whole point of the conflict clause: a person's "off" outlives a deploy.
  it("never re-enables an agent somebody switched off", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await db.insert(schema.agentEnablement).values({ organisationId: o.id, agentKey: "one", enabled: false });

      await ensureAgentsEnabled(db, ["one"], quiet);

      const [row] = await db.select().from(schema.agentEnablement)
        .where(and(eq(schema.agentEnablement.organisationId, o.id), eq(schema.agentEnablement.agentKey, "one")));
      expect(row!.enabled).toBe(false);
    });
  });

  it("adds only the agent that is new, leaving the settled ones alone", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await db.insert(schema.agentEnablement).values({ organisationId: o.id, agentKey: "one", enabled: false });

      await ensureAgentsEnabled(db, ["one", "two"], quiet);

      expect(await enablementFor(db, o.id)).toEqual({ one: false, two: true });
    });
  });

  it("is safe to run twice, which is what a restart does", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await ensureAgentsEnabled(db, ["one"], quiet);

      await ensureAgentsEnabled(db, ["one"], quiet);

      const rows = await db.select().from(schema.agentEnablement).where(eq(schema.agentEnablement.organisationId, o.id));
      expect(rows).toHaveLength(1);
    });
  });

  it("writes nothing when the registry is empty", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);

      expect(await ensureAgentsEnabled(db, [], quiet)).toEqual({ enabled: 0 });

      expect(await enablementFor(db, o.id)).toEqual({});
    });
  });
});
