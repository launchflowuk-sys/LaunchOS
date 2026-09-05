import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { requestContentApproval } from "./approval.js";
import { cancelContentItem, createContentItem, getContentItem, listContentItems, updateContentItem } from "./items.js";
import { auditRows, contentFixture } from "./test-fixtures.js";

describe("content items", () => {
  it("creates an item with the kind its channel implies and the month its date falls in", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const item = await createContentItem(db, orgId, {
        clientId, channel: "blog", title: "Airport runs", body: "Long form.", scheduledFor: new Date("2026-10-05T09:00:00Z"), actorId: ownerId,
      });
      expect(item.kind).toBe("blog_post");
      expect(item.status).toBe("draft");
      expect(item.periodKey).toBe("2026-10");
      expect(item.source).toBe("staff");
      expect(await auditRows(db, orgId, "content_item.created")).toHaveLength(1);

      const detail = await getContentItem(db, orgId, { itemId: item.id });
      expect(detail?.clientName).toBe("Grays CabLine");
    });
  });

  it("edits a draft, clears with null, and refuses once approved", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "facebook", body: "Hello", linkUrl: "https://grays.test" });

      const edited = await updateContentItem(db, orgId, { itemId: item.id, title: "Hi", linkUrl: null });
      expect(edited.title).toBe("Hi");
      expect(edited.linkUrl).toBeNull();
      expect(edited.body).toBe("Hello");

      await db.update(schema.contentItems).set({ status: "approved" }).where(eq(schema.contentItems.id, item.id));
      await expect(updateContentItem(db, orgId, { itemId: item.id, body: "Changed" })).rejects.toMatchObject({ name: "ContentRefused", reason: "not_editable" });
    });
  });

  it("returns a rejected item to draft when it is revised", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "facebook", body: "Hello" });
      await db.update(schema.contentItems).set({ status: "rejected" }).where(eq(schema.contentItems.id, item.id));

      const revised = await updateContentItem(db, orgId, { itemId: item.id, body: "Hello again" });
      expect(revised.status).toBe("draft");
      expect(await auditRows(db, orgId, "content_item.revised")).toHaveLength(1);
    });
  });

  it("cancels a waiting item and withdraws its pending approval", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "instagram", body: "Snap" });
      const { approval } = await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId });

      const cancelled = await cancelContentItem(db, orgId, { itemId: item.id, reason: "Client changed plans", actorId: ownerId });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.metadata).toMatchObject({ cancelReason: "Client changed plans" });

      const [withdrawn] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(withdrawn!.deletedAt).not.toBeNull();
      expect(withdrawn!.status).toBe("pending");
      expect(await auditRows(db, orgId, "approval.withdrawn")).toHaveLength(1);
      expect(await auditRows(db, orgId, "content_item.cancelled")).toHaveLength(1);

      await db.update(schema.contentItems).set({ status: "published" }).where(eq(schema.contentItems.id, item.id));
      await expect(cancelContentItem(db, orgId, { itemId: item.id })).rejects.toMatchObject({ reason: "not_cancellable" });
    });
  });

  it("lists with filters, in schedule order, paginated with a total", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      await createContentItem(db, orgId, { clientId, channel: "facebook", body: "B", scheduledFor: new Date("2026-09-20T09:00:00Z"), periodKey: "2026-09" });
      await createContentItem(db, orgId, { clientId, channel: "instagram", body: "A", scheduledFor: new Date("2026-09-10T09:00:00Z"), periodKey: "2026-09" });
      await createContentItem(db, orgId, { clientId, channel: "blog", body: "Undated", periodKey: "2026-09" });
      await createContentItem(db, orgId, { clientId, channel: "gbp", body: "Next month", periodKey: "2026-10" });
      await createContentItem(db, other.orgId, { clientId: other.clientId, channel: "facebook", body: "Theirs", periodKey: "2026-09" });

      const month = await listContentItems(db, orgId, { periodKey: "2026-09" });
      expect(month.total).toBe(3);
      expect(month.items.map((i) => i.body)).toEqual(["A", "B", "Undated"]);
      expect(month.items[0]!.clientName).toBe("Grays CabLine");

      const page = await listContentItems(db, orgId, { periodKey: "2026-09", limit: 2, offset: 2 });
      expect(page.total).toBe(3);
      expect(page.items.map((i) => i.body)).toEqual(["Undated"]);

      expect((await listContentItems(db, orgId, { channel: "gbp" })).items.map((i) => i.body)).toEqual(["Next month"]);
      expect((await listContentItems(db, orgId, { clientId, status: ["draft"] })).total).toBe(4);
      expect((await listContentItems(db, orgId, { clientId: other.clientId })).total).toBe(0);
      expect((await listContentItems(db, other.orgId)).total).toBe(1);
    });
  });

  it("never reaches another organisation's item", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "facebook", body: "Ours" });

      expect(await getContentItem(db, other.orgId, { itemId: item.id })).toBeUndefined();
      await expect(updateContentItem(db, other.orgId, { itemId: item.id, body: "Theirs" })).rejects.toMatchObject({ reason: "not_found" });
      await expect(cancelContentItem(db, other.orgId, { itemId: item.id })).rejects.toMatchObject({ reason: "not_found" });
      await expect(createContentItem(db, other.orgId, { clientId, channel: "facebook", body: "x" })).rejects.toThrow(/not found in organisation/);
    });
  });
});
