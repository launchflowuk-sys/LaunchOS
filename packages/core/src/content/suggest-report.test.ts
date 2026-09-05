import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { createContentItem } from "./items.js";
import { buildContentReport } from "./report.js";
import { periodKeyFor } from "./shared.js";
import { suggestContentItem } from "./suggest.js";
import { auditRows, contentFixture, ownerNotifications } from "./test-fixtures.js";

describe("suggestContentItem", () => {
  it("files a client draft in the current month and tells the owner", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, portalUserId } = await contentFixture(db);

      const item = await suggestContentItem(db, orgId, {
        clientId, actorUserId: portalUserId, text: "Could we post about the new wheelchair-accessible car?", linkUrl: "https://grays.test/wav",
      });
      expect(item.status).toBe("draft");
      expect(item.source).toBe("client");
      expect(item.channel).toBe("facebook");
      expect(item.kind).toBe("social_post");
      expect(item.suggestedByUserId).toBe(portalUserId);
      expect(item.periodKey).toBe(periodKeyFor(new Date()));
      expect(item.title).toBe("Could we post about the new wheelchair-accessible car?");
      expect(item.linkUrl).toBe("https://grays.test/wav");

      const audit = await auditRows(db, orgId, "content_item.suggested");
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorKind).toBe("client");
      const notes = await ownerNotifications(db, orgId);
      expect(notes.map((n) => [n.kind, n.title, n.link])).toEqual([["content_item.suggested", "Grays CabLine suggested a post", `/content/${item.id}`]]);
    });
  });

  it("refuses a user who is not an active portal user of that client, and another organisation", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, portalUserId, ownerId } = await contentFixture(db);
      const other = await contentFixture(db);

      await expect(suggestContentItem(db, orgId, { clientId, actorUserId: ownerId, text: "Staff are not portal users" }))
        .rejects.toMatchObject({ reason: "not_portal_user" });
      await expect(suggestContentItem(db, orgId, { clientId: other.clientId, actorUserId: portalUserId, text: "Wrong client" }))
        .rejects.toThrow(/not found in organisation/);
      await expect(suggestContentItem(db, orgId, { clientId, actorUserId: other.portalUserId, text: "Other client's user" }))
        .rejects.toMatchObject({ reason: "not_portal_user" });

      await db.update(schema.clientUsers).set({ status: "suspended" }).where(eq(schema.clientUsers.userId, portalUserId));
      await expect(suggestContentItem(db, orgId, { clientId, actorUserId: portalUserId, text: "Suspended" }))
        .rejects.toMatchObject({ reason: "not_portal_user" });
    });
  });
});

describe("buildContentReport", () => {
  it("summarises the month's published items with links and rebuilds the draft in place", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      const fb = await createContentItem(db, orgId, { clientId, channel: "facebook", title: "Airport fares", body: "x", periodKey: "2026-09" });
      const ig = await createContentItem(db, orgId, { clientId, channel: "instagram", body: "y", periodKey: "2026-09" });
      await createContentItem(db, orgId, { clientId, channel: "blog", body: "unpublished", periodKey: "2026-09" });
      const cancelled = await createContentItem(db, orgId, { clientId, channel: "gbp", body: "cancelled", periodKey: "2026-09" });
      await createContentItem(db, orgId, { clientId, channel: "gbp", body: "other month", periodKey: "2026-08" });
      await createContentItem(db, other.orgId, { clientId: other.clientId, channel: "facebook", body: "theirs", periodKey: "2026-09" });
      await db.update(schema.contentItems).set({
        status: "published", publishedAt: new Date("2026-09-12T09:00:00Z"), externalUrl: "https://www.facebook.com/1/posts/2",
      }).where(eq(schema.contentItems.id, fb.id));
      await db.update(schema.contentItems).set({ status: "published", publishedAt: new Date("2026-09-04T09:00:00Z") })
        .where(eq(schema.contentItems.id, ig.id));
      await db.update(schema.contentItems).set({ status: "cancelled" }).where(eq(schema.contentItems.id, cancelled.id));

      const report = await buildContentReport(db, orgId, { clientId, periodKey: "2026-09" });
      expect(report.status).toBe("draft");
      expect(report.stats).toMatchObject({ published: 2, planned: 3, byChannel: { facebook: 1, instagram: 1, blog: 0, gbp: 0 } });
      expect(report.stats.items!.map((i) => i.id)).toEqual([ig.id, fb.id]);
      expect(report.summaryMd).toContain("# Grays CabLine — content for September 2026");
      expect(report.summaryMd).toContain("2 of 3 planned posts published: 1 facebook post, 1 instagram post.");
      expect(report.summaryMd).toContain("- 4 Sep — Instagram post: Instagram post");
      expect(report.summaryMd).toContain("- 12 Sep — Facebook post: Airport fares — [View post](https://www.facebook.com/1/posts/2)");
      expect(report.summaryMd).not.toContain("theirs");

      const rebuilt = await buildContentReport(db, orgId, { clientId, periodKey: "2026-09" });
      expect(rebuilt.id).toBe(report.id);
      expect(await auditRows(db, orgId, "content_report.built")).toHaveLength(2);

      const empty = await buildContentReport(db, orgId, { clientId, periodKey: "2026-07" });
      expect(empty.summaryMd).toContain("No posts were published this month.");
      expect(empty.stats).toMatchObject({ published: 0, planned: 0 });
    });
  });

  it("never rewrites a sent report and cannot see another organisation's client", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db);
      const other = await contentFixture(db);
      const report = await buildContentReport(db, orgId, { clientId, periodKey: "2026-09" });
      await db.update(schema.contentReports).set({ status: "sent", summaryMd: "as sent" }).where(eq(schema.contentReports.id, report.id));

      const again = await buildContentReport(db, orgId, { clientId, periodKey: "2026-09" });
      expect(again.summaryMd).toBe("as sent");
      expect(await auditRows(db, orgId, "content_report.built")).toHaveLength(1);

      await expect(buildContentReport(db, other.orgId, { clientId, periodKey: "2026-09" })).rejects.toThrow(/not found in organisation/);
    });
  });
});
