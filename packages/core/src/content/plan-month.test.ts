import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { createTask } from "../tasks/create-task.js";
import { cancelContentItem } from "./items.js";
import { planContentMonth, slotsFor } from "./plan-month.js";
import { auditRows, contentFixture, INCLUDES } from "./test-fixtures.js";

const londonClock = (d: Date) =>
  d.toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

describe("slotsFor", () => {
  it("alternates facebook and instagram, numbering each channel from 1", () => {
    const slots = slotsFor("2026-09", INCLUDES);
    expect(slots.map((s) => `${s.channel}:${s.slot}`)).toEqual([
      "facebook:1", "instagram:1", "facebook:2", "instagram:2", "blog:1", "gbp:1", "gbp:2",
    ]);
    expect(slots.slice(0, 4).map((s) => s.sequence)).toEqual([1, 2, 3, 4]);
    expect(slotsFor("2026-09", { ...INCLUDES, socialPostsPerMonth: 0, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0 })).toEqual([]);
  });
});

describe("planContentMonth", () => {
  it("creates the month's empty slots from the package quotas at 10:00 London on weekdays", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, subscription } = await contentFixture(db);

      const result = await planContentMonth(db, orgId, { clientId, periodKey: "2026-09" });
      expect(result.created).toBe(7);
      expect(result.skipped).toBe(0);
      expect(result.items).toHaveLength(7);

      for (const item of result.items) {
        expect(item.status).toBe("draft");
        expect(item.source).toBe("agent");
        expect(item.body).toBeNull();
        expect(item.periodKey).toBe("2026-09");
        expect(item.metadata).toMatchObject({ plannedFromSubscriptionId: subscription!.id });
        const clock = londonClock(item.scheduledFor!);
        expect(clock).toMatch(/10:00$/);
        expect(clock).not.toMatch(/^(Sat|Sun)/);
      }
      const social = result.items.filter((i) => i.kind === "social_post");
      expect(social.map((i) => i.channel)).toEqual(["facebook", "instagram", "facebook", "instagram"]);
      expect(result.items.filter((i) => i.channel === "blog")).toHaveLength(1);
      expect(result.items.filter((i) => i.channel === "gbp")).toHaveLength(2);
      expect(await auditRows(db, orgId, "content_item.planned")).toHaveLength(7);
    });
  });

  it("is idempotent, tops up a missing slot, and leaves a cancelled slot cancelled", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const first = await planContentMonth(db, orgId, { clientId, periodKey: "2026-09" });

      const again = await planContentMonth(db, orgId, { clientId, periodKey: "2026-09" });
      expect(again.created).toBe(0);
      expect(again.skipped).toBe(7);
      expect(again.items.map((i) => i.id).sort()).toEqual(first.items.map((i) => i.id).sort());

      const cancelledId = first.items[0]!.id;
      await cancelContentItem(db, orgId, { itemId: cancelledId });
      const gbp = first.items.find((i) => i.channel === "gbp")!;
      await db.delete(schema.contentItems).where(eq(schema.contentItems.id, gbp.id));

      const topped = await planContentMonth(db, orgId, { clientId, periodKey: "2026-09" });
      expect(topped.created).toBe(1);
      expect(topped.skipped).toBe(6);
      expect(topped.items.find((i) => i.id === cancelledId)?.status).toBe("cancelled");
      const all = await db.select().from(schema.contentItems).where(and(eq(schema.contentItems.clientId, clientId)));
      expect(all).toHaveLength(7);
    });
  });

  it("links each slot to the month's recurring task by number, falling back to the first of its kind", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const social = await Promise.all([1, 2, 3, 4].map((n) => createTask(db, orgId, {
        clientId, title: `Social post ${n}/4`, kind: "social", phase: "recurring", recurrenceKey: `social:2026-09:${n}`,
      })));
      const [blog] = await Promise.all([createTask(db, orgId, {
        clientId, title: "Blog post", kind: "content", phase: "recurring", recurrenceKey: "content:2026-09:1",
      })]);
      // Only one GBP task this month although the quota says two.
      const gbp = await createTask(db, orgId, { clientId, title: "GBP", kind: "gbp", phase: "recurring", recurrenceKey: "gbp:2026-09:1" });
      // Another month's task must not be picked up.
      await createTask(db, orgId, { clientId, title: "Old", kind: "social", phase: "recurring", recurrenceKey: "social:2026-08:1" });

      const { items } = await planContentMonth(db, orgId, { clientId, periodKey: "2026-09" });
      const bySeq = items.filter((i) => i.kind === "social_post").sort((a, b) => Number(a.metadata.sequence) - Number(b.metadata.sequence));
      expect(bySeq.map((i) => i.taskId)).toEqual(social.map((t) => t.id));
      expect(items.find((i) => i.channel === "blog")!.taskId).toBe(blog!.id);
      expect(items.filter((i) => i.channel === "gbp").map((i) => i.taskId)).toEqual([gbp.id, gbp.id]);
    });
  });

  it("refuses without an active subscription and plans nothing for a package with no quotas", async () => {
    await withTestDb(async (db) => {
      const none = await contentFixture(db, { withSubscription: false });
      await expect(planContentMonth(db, none.orgId, { clientId: none.clientId, periodKey: "2026-09" }))
        .rejects.toMatchObject({ name: "ContentRefused", reason: "no_active_subscription" });

      const empty = await contentFixture(db, { includes: { ...INCLUDES, socialPostsPerMonth: 0, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0 } });
      const result = await planContentMonth(db, empty.orgId, { clientId: empty.clientId, periodKey: "2026-09" });
      expect(result).toEqual({ created: 0, skipped: 0, items: [] });
    });
  });

  it("cannot plan another organisation's client", async () => {
    await withTestDb(async (db) => {
      const { clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      await expect(planContentMonth(db, other.orgId, { clientId, periodKey: "2026-09" })).rejects.toThrow(/not found in organisation/);
      expect(await db.select().from(schema.contentItems).where(eq(schema.contentItems.organisationId, other.orgId))).toHaveLength(0);
    });
  });
});
