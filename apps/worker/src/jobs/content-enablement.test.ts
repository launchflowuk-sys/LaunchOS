import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CONTENT_WRITER_KEY } from "@launchos/agents";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { ensureContentWriterEnabled } from "./content-enablement.js";

const quiet = { info() {} };

async function enablement(db: Parameters<typeof ensureContentWriterEnabled>[0], organisationId: string) {
  const [row] = await db.select().from(schema.agentEnablement).where(and(
    eq(schema.agentEnablement.organisationId, organisationId), eq(schema.agentEnablement.agentKey, CONTENT_WRITER_KEY),
  ));
  return row;
}

describe("ensureContentWriterEnabled", () => {
  it("switches the writer on for an organisation that has never decided, and leaves a decision alone", async () => {
    await withTestDb(async (db) => {
      const [fresh] = await db.insert(schema.organisations).values({ name: "Fresh", slug: `fresh-${randomUUID()}` }).returning();
      const [off] = await db.insert(schema.organisations).values({ name: "Off", slug: `off-${randomUUID()}` }).returning();
      await db.insert(schema.agentEnablement)
        .values({ organisationId: off!.id, agentKey: CONTENT_WRITER_KEY, enabled: false, config: { policy: "approval_all" } });

      const first = await ensureContentWriterEnabled(db, quiet);

      expect(first.enabled).toBeGreaterThanOrEqual(1);
      expect((await enablement(db, fresh!.id))?.enabled).toBe(true);
      // A person turned it off: still off, config untouched.
      expect(await enablement(db, off!.id)).toMatchObject({ enabled: false, config: { policy: "approval_all" } });

      // Boot again: nothing to do.
      const second = await ensureContentWriterEnabled(db, quiet);
      expect(second.enabled).toBe(0);
    });
  });
});
