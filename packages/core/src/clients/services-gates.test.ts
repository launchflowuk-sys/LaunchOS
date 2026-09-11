import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { setEnqueue } from "../events/emit.js";
import { setContentChannel } from "../content/channels.js";
import { fanOutPublishedPost } from "../content/fan-out.js";
import { createContentItem } from "../content/items.js";
import { planContentMonth } from "../content/plan-month.js";
import { claimDueContent } from "../content/publishing.js";
import { contentFixture } from "../content/test-fixtures.js";
import { createTaskTemplate } from "../packages/create-task-template.js";
import { generateRecurringTasks } from "../tasks/generate-recurring-tasks.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { setClientService } from "./services.js";

/**
 * The gate, from the side of each job it guards: a service nobody switched on
 * produces no slots, no claims, no shares and no tasks, and a service switched
 * off holds its work rather than destroying it.
 */

setEnqueue(async () => {});

describe("planning a month", () => {
  it("plans only the services switched on, and does not call the rest unconnected", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { services: ["blog"] });

      const result = await planContentMonth(db, orgId, { clientId, periodKey: "2026-09" });

      expect(result.items.map((item) => item.channel)).toEqual(["blog"]);
      expect(result.unplanned).toEqual([]);
    });
  });

  it("refuses a client with no content service on, even one paying for posts with ads switched on", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { services: ["ads"] });

      await expect(planContentMonth(db, orgId, { clientId, periodKey: "2026-09" }))
        .rejects.toMatchObject({ reason: "service_inactive" });
      expect(await db.select().from(schema.contentItems).where(eq(schema.contentItems.clientId, clientId))).toHaveLength(0);
    });
  });
});

describe("publishing", () => {
  it("holds an approved post while its service is off, and sends it once the service is back on", async () => {
    await withTestDb(async (db) => {
      const now = new Date("2026-09-12T09:05:00Z");
      const { orgId, clientId } = await contentFixture(db);
      const facebook = await createContentItem(db, orgId, { clientId, channel: "facebook", body: "Held", scheduledFor: new Date("2026-09-10T09:00:00Z") });
      const gbp = await createContentItem(db, orgId, { clientId, channel: "gbp", body: "Goes", scheduledFor: new Date("2026-09-11T09:00:00Z") });
      await db.update(schema.contentItems).set({ status: "approved" }).where(eq(schema.contentItems.clientId, clientId));

      await setClientService(db, orgId, { clientId, service: "social", active: false, actorKind: "system" });
      expect((await claimDueContent(db, orgId, { now })).map((item) => item.id)).toEqual([gbp.id]);
      const [held] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, facebook.id));
      expect(held!.status).toBe("approved");

      await setClientService(db, orgId, { clientId, service: "social", active: true, actorKind: "system" });
      expect((await claimDueContent(db, orgId, { now })).map((item) => item.id)).toEqual([facebook.id]);
    });
  });
});

describe("blog fan-out", () => {
  it("shares a new article only to the services switched on", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      for (const channel of ["facebook", "gbp"] as const) {
        await setContentChannel(db, organisationId, { clientId, channel, externalId: `ext-${randomUUID()}`, enabled: true });
      }
      await setClientService(db, organisationId, { clientId, service: "social", active: false, actorKind: "system" });
      const [post] = await db.insert(schema.contentItems).values({
        organisationId, clientId, channel: "blog", kind: "blog_post", status: "published", periodKey: "2026-09",
        title: "Five signs", body: "…", externalUrl: "https://example.test/blog/five-signs", publishedAt: new Date("2026-09-07T14:12:00Z"),
      }).returning();

      const { created } = await fanOutPublishedPost(db, organisationId, post!);

      expect(created.map((share) => share.channel)).toEqual(["gbp"]);
    });
  });
});

describe("recurring service tasks", () => {
  it("creates no work for a service that is switched off", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, packageId } = await seedOrgWithClient(db);
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "social", title: "Social post", recurrence: "monthly", sortOrder: 10 });
      await createTaskTemplate(db, organisationId, { packageId, phase: "recurring", kind: "content", title: "Blog post", recurrence: "monthly", sortOrder: 20 });
      await setClientService(db, organisationId, { clientId, service: "social", active: false, actorKind: "system" });

      const result = await generateRecurringTasks(db, organisationId, { now: new Date("2026-10-14T06:00:00.000Z") });

      expect(result).toEqual({ created: 1, skipped: 0 });
      const keys = (await db.select().from(schema.tasks).where(eq(schema.tasks.clientId, clientId))).map((task) => task.recurrenceKey);
      expect(keys).toEqual(["content:2026-10:1"]);
    });
  });
});
