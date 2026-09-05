import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { decideApproval } from "../approvals/decide-approval.js";
import { applyContentPublishDecision, CONTENT_PUBLISH_ACTION, contentPublishSummary, requestContentApproval } from "./approval.js";
import { createContentItem } from "./items.js";
import { auditRows, contentFixture } from "./test-fixtures.js";

const LONG = "We now cover Stansted, Gatwick and Heathrow with fixed fares from Grays. Book online or call us any time of day.";

describe("requestContentApproval", () => {
  it("parks a content_publish approval with the spec's summary and moves the item to awaiting_approval", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const item = await createContentItem(db, orgId, {
        clientId, channel: "facebook", body: LONG, imageUrl: "https://cdn.test/a.jpg", scheduledFor: new Date("2026-09-12T09:00:00Z"),
      });

      const { item: after, approval } = await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId });

      expect(approval.kind).toBe("content_publish");
      expect(approval.status).toBe("pending");
      expect(approval.runId).toBeNull();
      expect(approval.title).toBe(
        "Publish Facebook post for Grays CabLine on 12 Sep: We now cover Stansted, Gatwick and Heathrow with fixed fares from Grays. Book on…",
      );
      expect(approval.payload).toMatchObject({
        action: CONTENT_PUBLISH_ACTION, itemId: item.id, clientId, clientName: "Grays CabLine", channel: "facebook",
        kind: "social_post", body: LONG, imageUrl: "https://cdn.test/a.jpg", scheduledFor: "2026-09-12T09:00:00.000Z",
        requestedByKind: "user", requestedById: ownerId,
      });
      expect(after.status).toBe("awaiting_approval");
      expect(after.approvalId).toBe(approval.id);
      expect(await auditRows(db, orgId, "content_item.approval_requested")).toHaveLength(1);

      const activity = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, clientId));
      expect(activity.map((a) => a.kind)).toEqual(["content_item.approval_requested"]);
    });
  });

  it("writes a short summary without a date and uses the title when there is no body text to quote", () => {
    const base = { channel: "blog" as const, scheduledFor: null, body: "Short.", title: null };
    expect(contentPublishSummary(base as never, "Acme")).toBe("Publish Blog post for Acme: Short.");
  });

  it("refuses an empty slot, a non-draft, and a second request for the same item", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const empty = await createContentItem(db, orgId, { clientId, channel: "gbp" });
      await expect(requestContentApproval(db, orgId, { itemId: empty.id, actorKind: "user", actorId: ownerId }))
        .rejects.toMatchObject({ reason: "empty_body" });

      const item = await createContentItem(db, orgId, { clientId, channel: "instagram", body: "Snap", imageUrl: "https://cdn.test/b.jpg" });
      await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "agent", actorId: "content-writer" });
      await expect(requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId }))
        .rejects.toMatchObject({ reason: "not_draft" });

      // The index is the last line of defence: force the status back and try again.
      await db.update(schema.contentItems).set({ status: "draft" }).where(eq(schema.contentItems.id, item.id));
      await expect(requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId }))
        .rejects.toMatchObject({ reason: "already_pending" });
      expect(await db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, orgId))).toHaveLength(1);
    });
  });

  it("cannot be raised against another organisation's item", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "facebook", body: "Ours" });
      await expect(requestContentApproval(db, other.orgId, { itemId: item.id, actorKind: "user", actorId: other.ownerId }))
        .rejects.toMatchObject({ reason: "not_found" });
    });
  });
});

describe("applyContentPublishDecision", () => {
  it("approve moves the item to approved, stamping now when it had no date, and applies at most once", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "facebook", body: "Go" });
      const { approval } = await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId });

      await expect(applyContentPublishDecision(db, orgId, { approvalId: approval.id, actorId: ownerId })).rejects.toThrow(/not been decided/);

      const before = Date.now();
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId, note: "Nice" });
      const applied = await applyContentPublishDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(applied).toMatchObject({ decision: "approved", itemId: item.id, clientId, alreadyApplied: false });
      expect(applied.item!.status).toBe("approved");
      expect(applied.item!.scheduledFor!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(await auditRows(db, orgId, "content_item.approved")).toHaveLength(1);
      expect(await auditRows(db, orgId, "approval.content_publish_approved_applied")).toHaveLength(1);
      const activity = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.kind, "content_item.approved"));
      expect(activity[0]!.body).toBe("Nice");

      const again = await applyContentPublishDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(again.alreadyApplied).toBe(true);
      expect(await auditRows(db, orgId, "content_item.approved")).toHaveLength(1);
    });
  });

  it("approve keeps a future date and clears a previous failure count", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const when = new Date("2030-01-07T10:00:00Z");
      const item = await createContentItem(db, orgId, { clientId, channel: "blog", body: "Later", scheduledFor: when });
      await db.update(schema.contentItems).set({ metadata: { publishAttempts: 2 } }).where(eq(schema.contentItems.id, item.id));
      const { approval } = await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });

      const { item: after } = await applyContentPublishDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(after!.scheduledFor!.toISOString()).toBe(when.toISOString());
      expect(after!.metadata).not.toHaveProperty("publishAttempts");
    });
  });

  it("reject moves the item to rejected", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "gbp", body: "No" });
      const { approval } = await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId });
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "rejected", decidedByUserId: ownerId, note: "Too salesy" });

      const applied = await applyContentPublishDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(applied.decision).toBe("rejected");
      expect(applied.item!.status).toBe("rejected");
      expect(await auditRows(db, orgId, "content_item.rejected")).toHaveLength(1);
    });
  });

  it("leaves an item alone that was cancelled under the card, and refuses another organisation", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db);
      const other = await contentFixture(db);
      const item = await createContentItem(db, orgId, { clientId, channel: "facebook", body: "Gone" });
      const { approval } = await requestContentApproval(db, orgId, { itemId: item.id, actorKind: "user", actorId: ownerId });
      await db.update(schema.contentItems).set({ status: "cancelled" }).where(eq(schema.contentItems.id, item.id));
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: ownerId });

      await expect(applyContentPublishDecision(db, other.orgId, { approvalId: approval.id, actorId: other.ownerId }))
        .rejects.toThrow(/not found in organisation/);

      const applied = await applyContentPublishDecision(db, orgId, { approvalId: approval.id, actorId: ownerId });
      expect(applied.alreadyApplied).toBe(false);
      expect(applied.item!.status).toBe("cancelled");
      expect(await auditRows(db, orgId, "content_item.approved")).toHaveLength(0);
    });
  });
});
