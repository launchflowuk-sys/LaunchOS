import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { activityDay, listStaffActivity, recordStaffActivity } from "./staff-activity.js";

const at = (iso: string) => new Date(iso);

async function fixture(db: Db, name = "Sam") {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const userId = crypto.randomUUID();
  await db.insert(schema.user).values({ id: userId, name, email: `${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "staff", status: "active" });
  return { organisationId: org!.id, userId };
}

describe("activityDay", () => {
  /** A day is the working day it felt like, not the UTC one. */
  it("uses the London day, so late-evening work in summer is not tomorrow", () => {
    expect(activityDay(at("2026-07-14T22:30:00Z"))).toBe("2026-07-14");
    expect(activityDay(at("2026-07-14T23:30:00Z"))).toBe("2026-07-15");
  });
});

describe("recordStaffActivity", () => {
  it("counts repeat visits to one screen instead of writing a row each time", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);

      for (let i = 0; i < 3; i += 1) {
        await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "/approvals", at: at("2026-09-09T10:00:00Z") });
      }

      const rows = await db.select().from(schema.staffActivity).where(eq(schema.staffActivity.organisationId, f.organisationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.views).toBe(3);
    });
  });

  it("keeps a separate count per day", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "/clients", at: at("2026-09-09T10:00:00Z") });
      await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "/clients", at: at("2026-09-10T10:00:00Z") });

      const rows = await db.select().from(schema.staffActivity).where(eq(schema.staffActivity.organisationId, f.organisationId));
      expect(rows.map((row) => row.day).sort()).toEqual(["2026-09-09", "2026-09-10"]);
    });
  });

  it("ignores an empty route rather than counting a blank one", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "   " });

      expect(await db.select().from(schema.staffActivity).where(eq(schema.staffActivity.organisationId, f.organisationId)))
        .toHaveLength(0);
    });
  });
});

describe("listStaffActivity", () => {
  it("reports the busiest screens first, with who was on them", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, "Sam Taylor");
      await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "/clients", at: at("2026-09-09T09:00:00Z") });
      for (let i = 0; i < 4; i += 1) {
        await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "/approvals", at: at("2026-09-09T10:00:00Z") });
      }

      const rows = await listStaffActivity(db, f.organisationId, at("2026-09-01T00:00:00Z"));
      expect(rows.map((row) => row.route)).toEqual(["/approvals", "/clients"]);
      expect(rows[0]!.views).toBe(4);
      expect(rows[0]!.name).toBe("Sam Taylor");
    });
  });

  it("narrows to one person, which is how somebody reads their own", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, "Sam");
      const otherId = crypto.randomUUID();
      await db.insert(schema.user).values({ id: otherId, name: "Alex", email: `${otherId}@example.test`, emailVerified: true });
      await db.insert(schema.organisationMembers)
        .values({ organisationId: f.organisationId, userId: otherId, role: "staff", status: "active" });

      await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "/clients", at: at("2026-09-09T09:00:00Z") });
      await recordStaffActivity(db, f.organisationId, { userId: otherId, route: "/inbox", at: at("2026-09-09T09:00:00Z") });

      const mine = await listStaffActivity(db, f.organisationId, at("2026-09-01T00:00:00Z"), f.userId);
      expect(mine.map((row) => row.route)).toEqual(["/clients"]);
    });
  });

  it("leaves out days before the window", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await recordStaffActivity(db, f.organisationId, { userId: f.userId, route: "/clients", at: at("2026-08-01T09:00:00Z") });

      expect(await listStaffActivity(db, f.organisationId, at("2026-09-01T00:00:00Z"))).toHaveLength(0);
    });
  });

  it("never reports another organisation's team", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db, "Not mine");
      await recordStaffActivity(db, theirs.organisationId, { userId: theirs.userId, route: "/clients", at: at("2026-09-09T09:00:00Z") });

      expect(await listStaffActivity(db, mine.organisationId, at("2026-09-01T00:00:00Z"))).toHaveLength(0);
    });
  });
});
