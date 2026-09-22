import { randomUUID } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { seedPortalShowcase } from "./portal-showcase.js";
import { removeDemoClients } from "./shared.js";

async function organisation(db: Db): Promise<string> {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `ps-${randomUUID()}` }).returning();
  return org!.id;
}

const NOW = new Date("2026-09-22T12:00:00Z");

describe("seedPortalShowcase", () => {
  /**
   * The point of the record: every panel on the client dashboard reads a
   * different table, so the seed is only useful if all of them come back
   * non-empty. A seed that quietly wrote half of it would leave exactly the
   * empty panels it exists to fill.
   */
  it("gives every dashboard panel something to show", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const { clientId, siteId } = await seedPortalShowcase(db, orgId, NOW);

      const count = async (table: "tickets" | "tasks" | "invoices" | "clientReports") => {
        const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema[table])
          .where(and(eq(schema[table].organisationId, orgId), eq(schema[table].clientId, clientId)));
        return row!.n;
      };

      expect(await count("tickets")).toBe(12);
      expect(await count("tasks")).toBe(20);
      expect(await count("invoices")).toBe(6);
      expect(await count("clientReports")).toBe(5);

      const [checks] = await db.select({ n: sql<number>`count(*)::int` })
        .from(schema.uptimeChecks)
        .innerJoin(schema.monitors, eq(schema.monitors.id, schema.uptimeChecks.monitorId))
        .where(eq(schema.monitors.siteId, siteId));
      expect(checks!.n).toBeGreaterThan(1000);
    });
  });

  /**
   * The numbers the dashboard puts on screen, computed the way the dashboard
   * will compute them. Uptime short of 100 and a response time that improved
   * are the two figures the design leans on, and a seed of flat, perfect data
   * would make both meaningless.
   */
  it("produces uptime below 100% and a response time that got better", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const { siteId } = await seedPortalShowcase(db, orgId, NOW);

      const window = async (fromDays: number, toDays: number) => {
        const [row] = await db
          .select({
            uptime: sql<number>`round(100.0 * sum(case when ${schema.uptimeChecks.ok} then 1 else 0 end) / count(*), 2)`,
            latency: sql<number>`round(avg(${schema.uptimeChecks.latencyMs}))`,
          })
          .from(schema.uptimeChecks)
          .innerJoin(schema.monitors, eq(schema.monitors.id, schema.uptimeChecks.monitorId))
          .where(and(
            eq(schema.monitors.siteId, siteId),
            // Drizzle operators, not a `sql` template: a raw Date interpolated
            // into one is sent as an object and Postgres rejects it.
            gt(schema.uptimeChecks.checkedAt, new Date(NOW.getTime() - fromDays * 86_400_000)),
            lte(schema.uptimeChecks.checkedAt, new Date(NOW.getTime() - toDays * 86_400_000)),
          ));
        return { uptime: Number(row!.uptime), latency: Number(row!.latency) };
      };

      const recent = await window(30, 0);
      const older = await window(182, 150);

      // Two recorded outages, so it is not a flat 100 — and not a bad number either.
      expect(recent.uptime).toBeGreaterThan(99);
      expect(recent.uptime).toBeLessThan(100);
      // The site got faster over the six months. The dashboard shows this as a delta.
      expect(recent.latency).toBeLessThan(older.latency);
    });
  });

  /** Cases a client can actually see, in more than one state, or the support panel is a single row. */
  it("leaves cases open as well as resolved, all of them client-visible", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const { clientId } = await seedPortalShowcase(db, orgId, NOW);

      const rows = await db.select({ status: schema.tickets.status, visible: schema.tickets.clientVisible })
        .from(schema.tickets)
        .where(and(eq(schema.tickets.organisationId, orgId), eq(schema.tickets.clientId, clientId)));

      expect(rows.every((r) => r.visible)).toBe(true);
      expect(new Set(rows.map((r) => r.status)).size).toBeGreaterThan(1);
      expect(rows.some((r) => r.status === "resolved")).toBe(true);
      expect(rows.some((r) => r.status !== "resolved")).toBe(true);
    });
  });

  /**
   * Re-seeding is how this gets used — change the data, run it again — so a
   * second run must not collide, and the first run must leave nothing behind.
   * `clients` cascades to tickets, tasks, invoices and reports, which is why
   * this record adds no removal code of its own; this is the test that says so.
   */
  it("removes completely, so it can be seeded again", async () => {
    await withTestDb(async (db) => {
      const orgId = await organisation(db);
      const first = await seedPortalShowcase(db, orgId, NOW);
      await removeDemoClients(db, orgId);

      for (const table of ["tickets", "tasks", "invoices", "clientReports"] as const) {
        const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema[table])
          .where(eq(schema[table].clientId, first.clientId));
        expect(row!.n, `${table} survived the removal`).toBe(0);
      }

      // And again, on the same slug, which is what a collision would break.
      const second = await seedPortalShowcase(db, orgId, NOW);
      expect(second.clientId).not.toBe(first.clientId);
    });
  });
});
