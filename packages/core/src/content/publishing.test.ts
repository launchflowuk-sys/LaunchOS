import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { createContentItem } from "./items.js";
import { claimDueContent, markContentFailed, markContentPublished, MAX_CONTENT_PUBLISH_ATTEMPTS } from "./publishing.js";
import { auditRows, contentFixture, ownerNotifications } from "./test-fixtures.js";

const NOW = new Date("2026-09-12T09:05:00Z");

async function approvedItem(db: Parameters<typeof createContentItem>[0], orgId: string, clientId: string, scheduledFor: Date, body = "Post") {
  const item = await createContentItem(db, orgId, { clientId, channel: "facebook", body, scheduledFor });
  await db.update(schema.contentItems).set({ status: "approved" }).where(eq(schema.contentItems.id, item.id));
  return item;
}

describe("claimDueContent", () => {
  it("claims approved items whose time has come, oldest first, bounded by limit, and audits each", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      const due1 = await approvedItem(db, orgId, clientId, new Date("2026-09-12T09:00:00Z"), "second");
      const due2 = await approvedItem(db, orgId, clientId, new Date("2026-09-10T09:00:00Z"), "first");
      const due3 = await approvedItem(db, orgId, clientId, new Date("2026-09-12T09:04:00Z"), "third");
      await approvedItem(db, orgId, clientId, new Date("2026-09-12T09:06:00Z"), "not yet");
      await createContentItem(db, orgId, { clientId, channel: "facebook", body: "draft", scheduledFor: new Date("2026-09-01T09:00:00Z") });
      await approvedItem(db, other.orgId, other.clientId, new Date("2026-09-01T09:00:00Z"), "theirs");

      const batch = await claimDueContent(db, orgId, { now: NOW, limit: 2 });
      expect(batch.map((i) => i.id)).toEqual([due2.id, due1.id]);
      expect(batch.every((i) => i.status === "publishing")).toBe(true);

      const rest = await claimDueContent(db, orgId, { now: NOW });
      expect(rest.map((i) => i.id)).toEqual([due3.id]);
      expect(await claimDueContent(db, orgId, { now: NOW })).toEqual([]);
      expect(await auditRows(db, orgId, "content_item.publishing")).toHaveLength(3);

      const theirs = await db.select().from(schema.contentItems).where(eq(schema.contentItems.organisationId, other.orgId));
      expect(theirs[0]!.status).toBe("approved");
    });
  });
});

describe("markContentPublished", () => {
  it("records the id and permalink, clears the error and writes the timeline", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const item = await approvedItem(db, orgId, clientId, new Date("2026-09-10T09:00:00Z"));
      await db.update(schema.contentItems).set({ lastError: "earlier" }).where(eq(schema.contentItems.id, item.id));
      await claimDueContent(db, orgId, { now: NOW });

      const published = await markContentPublished(db, orgId, {
        itemId: item.id, externalId: "123_456", externalUrl: "https://www.facebook.com/123/posts/456",
      });
      expect(published.status).toBe("published");
      expect(published.publishedAt).not.toBeNull();
      expect(published.externalId).toBe("123_456");
      expect(published.lastError).toBeNull();
      expect(await auditRows(db, orgId, "content_item.published")).toHaveLength(1);
      const activity = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.kind, "content_item.published"));
      expect(activity[0]!.link).toBe("https://www.facebook.com/123/posts/456");

      await expect(markContentPublished(db, orgId, { itemId: item.id, externalId: "again" })).rejects.toMatchObject({ reason: "not_publishing" });
    });
  });

  it("refuses an item that was never claimed and another organisation's item", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      const item = await approvedItem(db, orgId, clientId, new Date("2026-09-10T09:00:00Z"));
      await expect(markContentPublished(db, orgId, { itemId: item.id, externalId: "x" })).rejects.toMatchObject({ reason: "not_publishing" });
      await claimDueContent(db, orgId, { now: NOW });
      await expect(markContentPublished(db, other.orgId, { itemId: item.id, externalId: "x" })).rejects.toMatchObject({ reason: "not_found" });
    });
  });
});

describe("markContentFailed", () => {
  it("counts attempts and puts the item back in the queue until the third, then fails it and tells the owner", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const item = await approvedItem(db, orgId, clientId, new Date("2026-09-10T09:00:00Z"));

      for (let attempt = 1; attempt < MAX_CONTENT_PUBLISH_ATTEMPTS; attempt += 1) {
        expect(await claimDueContent(db, orgId, { now: NOW })).toHaveLength(1);
        const result = await markContentFailed(db, orgId, { itemId: item.id, error: `boom ${attempt}` });
        expect(result).toMatchObject({ attempts: attempt, exhausted: false });
        expect(result.item.status).toBe("approved");
        expect(result.item.lastError).toBe(`boom ${attempt}`);
        expect(result.item.metadata).toMatchObject({ publishAttempts: attempt });
      }
      expect(await ownerNotifications(db, orgId)).toHaveLength(0);

      expect(await claimDueContent(db, orgId, { now: NOW })).toHaveLength(1);
      const last = await markContentFailed(db, orgId, { itemId: item.id, error: "boom 3" });
      expect(last).toMatchObject({ attempts: 3, exhausted: true });
      expect(last.item.status).toBe("failed");
      expect(await claimDueContent(db, orgId, { now: NOW })).toEqual([]);

      const notes = await ownerNotifications(db, orgId);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.kind).toBe("content_item.failed");
      expect(notes[0]!.title).toBe("A facebook post for Grays CabLine could not be published");
      expect(notes[0]!.link).toBe(`/content/${item.id}`);
      expect(await auditRows(db, orgId, "content_item.publish_retry")).toHaveLength(2);
      expect(await auditRows(db, orgId, "content_item.failed")).toHaveLength(1);
    });
  });

  it("fails straight away when the error is not worth retrying", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const item = await approvedItem(db, orgId, clientId, new Date("2026-09-10T09:00:00Z"));
      await claimDueContent(db, orgId, { now: NOW });

      const result = await markContentFailed(db, orgId, { itemId: item.id, error: "Instagram needs an image", retry: false });
      expect(result).toMatchObject({ attempts: 1, exhausted: true });
      expect(result.item.status).toBe("failed");
      expect(await ownerNotifications(db, orgId)).toHaveLength(1);
    });
  });
});
