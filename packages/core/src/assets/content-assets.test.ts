import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { contentFixture } from "../content/test-fixtures.js";
import {
  ContentAssetRefused, MAX_CONTENT_ASSET_BYTES, createContentAsset, deleteContentAsset, getContentAsset,
  listContentAssets, publicAssetUrl, readContentAsset,
} from "./content-assets.js";

let storage: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "launchos-assets-"));
  env = { STORAGE_DIR: storage, APP_URL: "https://os.test/" } as NodeJS.ProcessEnv;
});
afterAll(async () => { await rm(storage, { recursive: true, force: true }); });

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe("content assets", () => {
  it("stores a JPEG/PNG/WebP under STORAGE_DIR/content/<org>/, lists it with its public URL, reads it back by id, deletes file and row", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db, { withSubscription: false });
      const asset = await createContentAsset(db, orgId, {
        clientId, bytes: png, mime: "image/png; charset=binary", originalName: "../van photo.PNG", alt: "Our van", actorId: ownerId,
      }, env);
      expect(asset.path).toBe(`content/${orgId}/${asset.id}.png`);
      expect(asset.mime).toBe("image/png");
      expect(asset.sizeBytes).toBe(png.byteLength);
      expect(asset.originalName).toBe("../van photo.PNG");
      expect(asset.uploadedByUserId).toBe(ownerId);
      expect((await stat(join(storage, "content", orgId, `${asset.id}.png`))).size).toBe(png.byteLength);

      const listed = await listContentAssets(db, orgId, { clientId }, env);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.url).toBe(`https://os.test/api/assets/${asset.id}`);
      expect(publicAssetUrl(asset.id, env)).toBe(listed[0]!.url);

      const read = await readContentAsset(db, asset.id, env);
      expect(read?.asset.mime).toBe("image/png");
      expect([...read!.bytes]).toEqual([...png]);
      expect(await readContentAsset(db, "not-a-uuid", env)).toBeNull();
      expect(await readContentAsset(db, "00000000-0000-0000-0000-000000000000", env)).toBeNull();

      const removed = await deleteContentAsset(db, orgId, { assetId: asset.id, actorId: ownerId }, env);
      expect(removed?.id).toBe(asset.id);
      await expect(stat(join(storage, "content", orgId, `${asset.id}.png`))).rejects.toThrow();
      expect(await listContentAssets(db, orgId, { clientId }, env)).toHaveLength(0);
      expect(await readContentAsset(db, asset.id, env)).toBeNull();
      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.targetType, "content_asset")));
      expect(audits.map((a) => a.action).sort()).toEqual(["content_asset.created", "content_asset.deleted"]);
    });
  });

  it("refuses the wrong type, an empty file and one over 8 MB, and writes nothing", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      const refuse = (input: Parameters<typeof createContentAsset>[2]) => createContentAsset(db, orgId, input, env).catch((e: unknown) => e);
      const gif = await refuse({ clientId, bytes: png, mime: "image/gif" });
      expect(gif).toBeInstanceOf(ContentAssetRefused);
      expect((gif as ContentAssetRefused).reason).toBe("unsupported_type");
      expect(((await refuse({ clientId, bytes: new Uint8Array(0), mime: "image/png" })) as ContentAssetRefused).reason).toBe("empty");
      const big = new Uint8Array(MAX_CONTENT_ASSET_BYTES + 1);
      expect(((await refuse({ clientId, bytes: big, mime: "image/jpeg" })) as ContentAssetRefused).reason).toBe("too_large");
      expect(await listContentAssets(db, orgId, { clientId }, env)).toHaveLength(0);
    });
  });

  it("keeps organisations apart everywhere the organisation is known", async () => {
    await withTestDb(async (db) => {
      const a = await contentFixture(db, { withSubscription: false });
      const b = await contentFixture(db, { withSubscription: false, name: "Other" });
      await expect(createContentAsset(db, b.orgId, { clientId: a.clientId, bytes: png, mime: "image/png" }, env)).rejects.toThrow(/not found in organisation/);
      const asset = await createContentAsset(db, a.orgId, { clientId: a.clientId, bytes: png, mime: "image/webp" }, env);
      expect(await getContentAsset(db, b.orgId, { assetId: asset.id })).toBeNull();
      expect(await listContentAssets(db, b.orgId, { clientId: b.clientId }, env)).toHaveLength(0);
      expect(await deleteContentAsset(db, b.orgId, { assetId: asset.id }, env)).toBeNull();
      expect(await getContentAsset(db, a.orgId, { assetId: asset.id })).not.toBeNull();
      await deleteContentAsset(db, a.orgId, { assetId: asset.id }, env);
    });
  });
});
