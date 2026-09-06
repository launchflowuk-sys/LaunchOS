import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentAsset, deleteContentAsset } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let currentDb: Db | undefined;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));

import { GET } from "./route.js";

let storageDir: string;
const previousStorage = process.env.STORAGE_DIR;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "launchos-assets-"));
  process.env.STORAGE_DIR = storageDir;
});

afterAll(async () => {
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  await rm(storageDir, { recursive: true, force: true });
});

async function seed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `assets-route-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  return { organisationId: org!.id, clientId: client!.id };
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/assets/${id}`), { params: Promise.resolve({ id }) });
}

describe("GET /api/assets/[id]", () => {
  afterEach(() => {
    currentDb = undefined;
  });

  it("serves the bytes with the asset's type and a year of immutable cache", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, clientId } = await seed(db);
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const asset = await createContentAsset(db, organisationId, { clientId, bytes, mime: "image/png", originalName: "van.png" });

      const res = await get(asset.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("content-length")).toBe("7");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    });
  });

  it("is a 404 for a malformed id, an unknown id and a deleted asset", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, clientId } = await seed(db);
      expect((await get("not-a-uuid")).status).toBe(404);
      expect((await get(randomUUID())).status).toBe(404);

      const asset = await createContentAsset(db, organisationId, { clientId, bytes: new Uint8Array([1]), mime: "image/webp" });
      await deleteContentAsset(db, organisationId, { assetId: asset.id });
      expect((await get(asset.id)).status).toBe(404);
    });
  });
});
