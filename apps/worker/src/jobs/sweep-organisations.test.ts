import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { sweepOrganisations } from "./sweep-organisations.js";

async function organisation(db: Db, slug: string) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `${slug}-${randomUUID()}` }).returning();
  return org!.id;
}

describe("sweepOrganisations", () => {
  it("runs every organisation and reports the counts", async () => {
    await withTestDb(async (db) => {
      const a = await organisation(db, "sweep-a");
      const b = await organisation(db, "sweep-b");
      const seen: string[] = [];
      const logger = { error: vi.fn(), info: vi.fn() };

      const summary = await sweepOrganisations(db, "test sweep", async (id) => { seen.push(id); }, logger);

      expect(seen).toEqual(expect.arrayContaining([a, b]));
      expect(summary.failed).toBe(0);
      expect(logger.info).toHaveBeenCalledWith({ processed: summary.processed, failed: 0 }, "test sweep");
    });
  });

  it("sweeps the rest when one organisation throws, logs the summary, then fails the job", async () => {
    await withTestDb(async (db) => {
      const bad = await organisation(db, "sweep-bad");
      const good = await organisation(db, "sweep-good");
      const seen: string[] = [];
      const logger = { error: vi.fn(), info: vi.fn() };

      // The whole point of the module: pg-boss must still retry (hence the
      // throw), but only after every other organisation has had its turn and
      // the counts have been logged.
      await expect(
        sweepOrganisations(db, "test sweep", async (id) => {
          if (id === bad) throw new Error("bad org");
          seen.push(id);
        }, logger),
      ).rejects.toThrow(AggregateError);

      expect(seen).toContain(good);
      expect(seen).not.toContain(bad);
      expect(logger.error).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ failed: 1 }),
        "test sweep",
      );
    });
  });
});
