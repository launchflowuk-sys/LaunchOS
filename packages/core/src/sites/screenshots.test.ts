import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import {
  MockScreenshotAdapter,
  ScreenshotFailed,
  type ScreenshotAdapter,
} from "@launchos/integrations";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contentFixture } from "../content/test-fixtures.js";
import {
  captureSiteScreenshot,
  readSiteThumbnail,
  siteThumbnails,
  sitesMissingScreenshot,
} from "./screenshots.js";

async function seedSite(
  db: Db,
  organisationId: string,
  clientId: string,
  url: string,
  status: "live" | "archived" = "live",
) {
  const [site] = await db
    .insert(schema.sites)
    .values({ organisationId, clientId, name: url, primaryUrl: url, status })
    .returning();
  return site!;
}

const REAL_ADAPTER: ScreenshotAdapter = {
  name: "screenshotone",
  async capture() {
    return {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mime: "image/png",
      width: 960,
      height: 600,
      adapter: "screenshotone",
    };
  },
};

describe("site screenshots", () => {
  it("stores the bytes and reports the site as having an image", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, {
        withSubscription: false,
      });
      const site = await seedSite(
        db,
        orgId,
        clientId,
        "https://grayscabline.co.uk",
      );

      const result = await captureSiteScreenshot(
        db,
        orgId,
        { siteId: site.id, url: site.primaryUrl },
        new MockScreenshotAdapter(),
      );

      expect(result).toEqual({ siteId: site.id, ok: true, reason: null });

      const thumbnail = await readSiteThumbnail(db, orgId, site.id);
      expect(thumbnail?.mime).toBe("image/png");
      // A real PNG, not a placeholder string: the first eight bytes are the signature.
      expect([...thumbnail!.bytes.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      const map = await siteThumbnails(db, orgId, [site.id]);
      expect(map.get(site.id)).toMatchObject({
        hasImage: true,
        failureReason: null,
        adapter: "mock",
      });
    });
  });

  it("records a failure without throwing, so one bad site does not stop the others", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, {
        withSubscription: false,
      });
      const site = await seedSite(
        db,
        orgId,
        clientId,
        "https://broken.example",
      );
      const adapter = new MockScreenshotAdapter();
      adapter.failNext = new ScreenshotFailed(
        "unreachable",
        "no answer within 30000 ms",
      );

      const result = await captureSiteScreenshot(
        db,
        orgId,
        { siteId: site.id, url: site.primaryUrl },
        adapter,
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("no answer");
      const map = await siteThumbnails(db, orgId, [site.id]);
      expect(map.get(site.id)).toMatchObject({
        hasImage: false,
        capturedAt: null,
      });
    });
  });

  it("keeps the last good picture when a later capture fails", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, {
        withSubscription: false,
      });
      const site = await seedSite(
        db,
        orgId,
        clientId,
        "https://grayscabline.co.uk",
      );
      const adapter = new MockScreenshotAdapter();
      await captureSiteScreenshot(
        db,
        orgId,
        { siteId: site.id, url: site.primaryUrl },
        adapter,
      );

      adapter.failNext = new ScreenshotFailed("refused", "403 from the site");
      await captureSiteScreenshot(
        db,
        orgId,
        { siteId: site.id, url: site.primaryUrl },
        adapter,
      );

      // Yesterday's picture is more useful than a blank square; the reason says
      // it is stale.
      const thumbnail = await readSiteThumbnail(db, orgId, site.id);
      expect(thumbnail).not.toBeNull();
      const map = await siteThumbnails(db, orgId, [site.id]);
      expect(map.get(site.id)).toMatchObject({
        hasImage: true,
        failureReason: "403 from the site",
      });
    });
  });

  it("refuses a private address rather than fetching it", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, {
        withSubscription: false,
      });
      const site = await seedSite(db, orgId, clientId, "http://localhost:5432");

      const result = await captureSiteScreenshot(
        db,
        orgId,
        { siteId: site.id, url: site.primaryUrl },
        new MockScreenshotAdapter(),
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("private address");
    });
  });

  it("refuses an image over the ceiling, so the table cannot become a filesystem", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, {
        withSubscription: false,
      });
      const site = await seedSite(db, orgId, clientId, "https://huge.example");
      const oversized: ScreenshotAdapter = {
        name: "oversized",
        async capture() {
          return {
            bytes: new Uint8Array(2_000_001),
            mime: "image/png",
            width: 960,
            height: 600,
            adapter: "oversized",
          };
        },
      };

      const result = await captureSiteScreenshot(
        db,
        orgId,
        { siteId: site.id, url: site.primaryUrl },
        oversized,
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("ceiling");
      expect(await readSiteThumbnail(db, orgId, site.id)).toBeNull();
    });
  });

  it("offers only sites never captured, and skips archived ones", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, {
        withSubscription: false,
      });
      const shot = await seedSite(
        db,
        orgId,
        clientId,
        "https://already.example",
      );
      const fresh = await seedSite(
        db,
        orgId,
        clientId,
        "https://never.example",
      );
      const archived = await seedSite(
        db,
        orgId,
        clientId,
        "https://gone.example",
        "archived",
      );
      await captureSiteScreenshot(
        db,
        orgId,
        { siteId: shot.id, url: shot.primaryUrl },
        REAL_ADAPTER,
      );

      const due = await sitesMissingScreenshot(db, orgId, 10);
      const ids = due.map((row) => row.id);

      expect(ids).toContain(fresh.id);
      // The one already photographed is not re-shot: a thumbnail identifies a
      // site and that does not change, so a second capture is money for nothing.
      expect(ids).not.toContain(shot.id);
      expect(ids).not.toContain(archived.id);
    });
  });

  it("never returns another organisation's thumbnail", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, {
        withSubscription: false,
      });
      const site = await seedSite(
        db,
        orgId,
        clientId,
        "https://grayscabline.co.uk",
      );
      await captureSiteScreenshot(
        db,
        orgId,
        { siteId: site.id, url: site.primaryUrl },
        new MockScreenshotAdapter(),
      );
      const other = await contentFixture(db, {
        withSubscription: false,
        name: "Other",
      });

      expect(await readSiteThumbnail(db, other.orgId, site.id)).toBeNull();
      expect((await siteThumbnails(db, other.orgId, [site.id])).size).toBe(0);
      // And the row itself is still there for its owner.
      const rows = await db
        .select()
        .from(schema.siteScreenshots)
        .where(eq(schema.siteScreenshots.siteId, site.id));
      expect(rows).toHaveLength(1);
    });
  });

  it("treats a mock capture as no picture, so a real provider replaces placeholders on its own", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      const site = await seedSite(db, orgId, clientId, "https://placeholder.example");
      // Captured by the mock: a coloured square, not a picture of the site.
      await captureSiteScreenshot(db, orgId, { siteId: site.id, url: site.primaryUrl }, new MockScreenshotAdapter());

      // Still offered, because configuring a real provider must not require
      // pressing Refresh on every site by hand.
      expect((await sitesMissingScreenshot(db, orgId, 10)).map((r) => r.id)).toContain(site.id);

      await captureSiteScreenshot(db, orgId, { siteId: site.id, url: site.primaryUrl }, REAL_ADAPTER);

      // Once it is a real picture it stops being offered.
      expect((await sitesMissingScreenshot(db, orgId, 10)).map((r) => r.id)).not.toContain(site.id);
    });
  });
});
