import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildClientReport } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { runMonthlyReports } from "./reports-monthly.js";

const NOW = new Date("2026-09-01T07:45:00Z");

describe("runMonthlyReports", () => {
  it("drafts last month's report for every active client and skips archived ones", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `mr-${randomUUID()}` }).returning();
      const [active] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
      await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Gone", slug: `gone-${randomUUID()}`, status: "archived" });

      const result = await runMonthlyReports(db, org!.id, { now: NOW });

      expect(result).toEqual({ clients: 1, reports: 1, skipped: 0, failed: 0, periodStart: "2026-08-01" });
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.clientId, active!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("draft");
      expect(rows[0]!.periodStart).toBe("2026-08-01");
    });
  });

  it("is safe to run twice for the same month", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `mr2-${randomUUID()}` }).returning();
      await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` });
      await runMonthlyReports(db, org!.id, { now: NOW });
      await runMonthlyReports(db, org!.id, { now: NOW });
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.organisationId, org!.id));
      expect(rows).toHaveLength(1);
    });
  });

  it("counts an already-published report as skipped rather than rebuilt", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `mr3-${randomUUID()}` }).returning();
      const [client] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();

      await runMonthlyReports(db, org!.id, { now: NOW });
      await db.update(schema.clientReports)
        .set({ status: "published" })
        .where(eq(schema.clientReports.clientId, client!.id));

      const result = await runMonthlyReports(db, org!.id, { now: NOW });

      // The upsert refuses to overwrite a published row, so this client's
      // report was not rebuilt — `reports` must not claim it was.
      expect(result).toMatchObject({ clients: 1, reports: 0, skipped: 1, failed: 0 });
    });
  });

  it("builds every other client's report when one client throws, then fails the job", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `mr4-${randomUUID()}` }).returning();
      const [bad] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Bad", slug: `bad-${randomUUID()}` }).returning();
      const [good] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Good", slug: `good-${randomUUID()}` }).returning();

      // Everything real except this one client, which blows up the way a
      // deadlock or a null column would.
      const build = vi.fn(async (...args: Parameters<typeof buildClientReport>) => {
        if (args[2] === bad!.id) throw new Error("upsert deadlock");
        return buildClientReport(...args);
      });

      await expect(runMonthlyReports(db, org!.id, { now: NOW, build, logger: { error: vi.fn() } }))
        .rejects.toThrow(AggregateError);

      // The surviving client still has its draft: one bad client must not cost
      // the rest of the agency its month.
      const rows = await db.select().from(schema.clientReports)
        .where(eq(schema.clientReports.organisationId, org!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.clientId).toBe(good!.id);
      expect(build).toHaveBeenCalledTimes(2);
    });
  });
});
