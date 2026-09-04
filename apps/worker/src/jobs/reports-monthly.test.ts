import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { runMonthlyReports } from "./reports-monthly.js";

describe("runMonthlyReports", () => {
  it("drafts last month's report for every active client and skips archived ones", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `mr-${randomUUID()}` }).returning();
      const [active] = await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
      await db.insert(schema.clients)
        .values({ organisationId: org!.id, name: "Gone", slug: `gone-${randomUUID()}`, status: "archived" });

      const result = await runMonthlyReports(db, org!.id, { now: new Date("2026-09-01T05:00:00Z") });

      expect(result).toEqual({ clients: 1, reports: 1, periodStart: "2026-08-01" });
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
      const now = new Date("2026-09-01T05:00:00Z");
      await runMonthlyReports(db, org!.id, { now });
      await runMonthlyReports(db, org!.id, { now });
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.organisationId, org!.id));
      expect(rows).toHaveLength(1);
    });
  });
});
