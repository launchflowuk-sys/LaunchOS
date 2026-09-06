import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockImageGenAdapter } from "@launchos/integrations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE } from "../boss.js";
import { approvedItem, contentJobFixture, itemById, silentLogger } from "./content-test-fixture.js";
import { backfillDueImages, handleContentRenderImage, renderImageKey } from "./content-render-image.js";

const DUE = new Date("2026-09-10T10:00:00Z");
const NOW = new Date("2026-09-10T10:04:00Z");

// The renderer writes the picture to STORAGE_DIR, and core reads it from
// process.env exactly as it does in the worker.
let storage: string;
let previous: string | undefined;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "launchos-worker-images-"));
  previous = process.env["STORAGE_DIR"];
  process.env["STORAGE_DIR"] = storage;
});
afterAll(async () => {
  if (previous === undefined) delete process.env["STORAGE_DIR"];
  else process.env["STORAGE_DIR"] = previous;
  await rm(storage, { recursive: true, force: true });
});

describe("renderImageKey", () => {
  it("keys one job per item, so a double press collapses while the first is queued", () => {
    expect(renderImageKey("11111111-1111-1111-1111-111111111111")).toBe("render-image:11111111-1111-1111-1111-111111111111");
  });
});

describe("handleContentRenderImage", () => {
  it("draws the picture, records the render as the queue, and refuses the second job rather than spending twice", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const item = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE);
      const imagegen = new MockImageGenAdapter();
      const deps = { db, imagegen, logger: silentLogger() };

      const first = await handleContentRenderImage(deps, { organisationId: f.orgId, itemId: item.id });
      expect(first).toMatchObject({ rendered: true, mode: "template", costPence: 0 });

      const after = await itemById(db, item.id);
      expect(after.imageUrl).toMatch(/\/api\/assets\//);
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, item.id));
      expect(audits.some((a) => a.action === "content_item.image_rendered" && a.actorId === QUEUE.contentRenderImage)).toBe(true);

      // A retry, or a second press that beat the dedupe: no picture is drawn
      // and no money is spent, because the item already has one.
      expect(await handleContentRenderImage(deps, { organisationId: f.orgId, itemId: item.id }))
        .toMatchObject({ rendered: false, reason: "already_has_image" });
      expect(imagegen.calls).toHaveLength(0);
    });
  });

  it("refuses a payload that is not a job at all", async () => {
    await withTestDb(async (db) => {
      const deps = { db, imagegen: new MockImageGenAdapter(), logger: silentLogger() };
      await expect(handleContentRenderImage(deps, { organisationId: "not-a-uuid", itemId: "nor-this" })).rejects.toThrow();
    });
  });
});

describe("backfillDueImages", () => {
  it("gives a due, approved, image-less social post a branded graphic — and never reaches the generator", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const social = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE);
      const withPhoto = await approvedItem(db, f.orgId, f.clientId, "instagram", DUE, { imageUrl: "https://os.test/api/assets/already-there" });
      const blog = await approvedItem(db, f.orgId, f.clientId, "blog", DUE, { title: "A post" });
      const later = await approvedItem(db, f.orgId, f.clientId, "gbp", new Date("2026-09-20T10:00:00Z"));
      const imagegen = new MockImageGenAdapter();

      const result = await backfillDueImages({ db, imagegen, logger: silentLogger() }, f.orgId, NOW);

      expect(result).toEqual({ considered: 1, rendered: 1 });
      expect((await itemById(db, social.id)).imageUrl).toMatch(/\/api\/assets\//);
      // Untouched: one already has a photo, the blog's featured image is a
      // person's choice, and the fourth is not due yet.
      expect((await itemById(db, withPhoto.id)).imageUrl).toBe("https://os.test/api/assets/already-there");
      expect((await itemById(db, blog.id)).imageUrl).toBeNull();
      expect((await itemById(db, later.id)).imageUrl).toBeNull();
      // Template mode only: nothing unattended may spend.
      expect(imagegen.calls).toHaveLength(0);
      const [rendered] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, social.id));
      expect((rendered!.metadata as { image?: { mode: string; costPence: number } }).image)
        .toMatchObject({ mode: "template", costPence: 0 });
    });
  });

  it("leaves another organisation's due post alone", async () => {
    await withTestDb(async (db) => {
      const mine = await contentJobFixture(db);
      const theirs = await contentJobFixture(db);
      const ours = await approvedItem(db, mine.orgId, mine.clientId, "facebook", DUE);
      const other = await approvedItem(db, theirs.orgId, theirs.clientId, "facebook", DUE);

      const result = await backfillDueImages({ db, imagegen: new MockImageGenAdapter(), logger: silentLogger() }, mine.orgId, NOW);

      expect(result).toEqual({ considered: 1, rendered: 1 });
      expect((await itemById(db, ours.id)).imageUrl).toMatch(/\/api\/assets\//);
      expect((await itemById(db, other.id)).imageUrl).toBeNull();
    });
  });

  it("does not stop the sweep when one post cannot be drawn", async () => {
    await withTestDb(async (db) => {
      const f = await contentJobFixture(db);
      const empty = await approvedItem(db, f.orgId, f.clientId, "facebook", DUE);
      await db.update(schema.contentItems).set({ body: null }).where(eq(schema.contentItems.id, empty.id));
      const good = await approvedItem(db, f.orgId, f.clientId, "gbp", DUE);

      const result = await backfillDueImages({ db, imagegen: new MockImageGenAdapter(), logger: silentLogger() }, f.orgId, NOW);

      expect(result).toEqual({ considered: 2, rendered: 1 });
      expect((await itemById(db, good.id)).imageUrl).toMatch(/\/api\/assets\//);
      expect((await itemById(db, empty.id)).imageUrl).toBeNull();
    });
  });
});
