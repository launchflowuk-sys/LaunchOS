import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listContentAssets } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type FakeSession = { userId: string; email: string; organisationId: string; role: "owner" | "staff" } | null;

let currentDb: Db | undefined;
let currentSession: FakeSession = null;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));
vi.mock("@/lib/session", () => ({ getSession: async () => currentSession }));

import { POST } from "./route.js";

let storageDir: string;
const previousStorage = process.env.STORAGE_DIR;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "launchos-client-assets-"));
  process.env.STORAGE_DIR = storageDir;
});

afterAll(async () => {
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  await rm(storageDir, { recursive: true, force: true });
});

async function seed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `client-assets-${randomUUID()}` }).returning();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: `o-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  return { organisationId: org!.id, userId, clientId: client!.id };
}

function upload(clientId: string, file: File | null, alt?: string): Promise<Response> {
  const form = new FormData();
  if (file) form.set("file", file);
  if (alt !== undefined) form.set("alt", alt);
  const request = new Request(`http://localhost/api/clients/${clientId}/assets`, { method: "POST", body: form });
  return POST(request, { params: Promise.resolve({ id: clientId }) });
}

const jpeg = (bytes = 64) => new File([new Uint8Array(bytes)], "van.jpg", { type: "image/jpeg" });

describe("POST /api/clients/[id]/assets", () => {
  afterEach(() => {
    currentDb = undefined;
    currentSession = null;
  });

  it("refuses with 401 when nobody is signed in", async () => {
    expect((await upload(randomUUID(), jpeg())).status).toBe(401);
  });

  it("stores the image in the client's library with its name, size and alt text", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, userId, clientId } = await seed(db);
      currentSession = { userId, email: "o@example.test", organisationId, role: "owner" };

      const res = await upload(clientId, jpeg(), "The van outside the office");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { asset: { id: string; originalName: string; sizeBytes: number } };
      expect(json.asset.originalName).toBe("van.jpg");
      expect(json.asset.sizeBytes).toBe(64);

      const assets = await listContentAssets(db, organisationId, { clientId });
      expect(assets).toHaveLength(1);
      expect(assets[0]?.alt).toBe("The van outside the office");
      expect(assets[0]?.source).toBe("staff");
      expect(assets[0]?.uploadedByUserId).toBe(userId);
      expect(assets[0]?.url).toMatch(new RegExp(`/api/assets/${json.asset.id}$`));
    });
  });

  it("refuses a missing file, a non-image and an oversized one", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, userId, clientId } = await seed(db);
      currentSession = { userId, email: "o@example.test", organisationId, role: "owner" };

      expect((await upload(clientId, null)).status).toBe(400);
      expect((await upload(clientId, new File(["%PDF"], "brochure.pdf", { type: "application/pdf" }))).status).toBe(415);
      expect((await upload(clientId, jpeg(8 * 1024 * 1024 + 1))).status).toBe(413);
      expect(await listContentAssets(db, organisationId, { clientId })).toHaveLength(0);
    });
  });

  it("is a 404 for another organisation's client", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const theirs = await seed(db);
      const ours = await seed(db);
      currentSession = { userId: ours.userId, email: "o@example.test", organisationId: ours.organisationId, role: "owner" };

      expect((await upload(theirs.clientId, jpeg())).status).toBe(404);
      expect((await upload("not-a-uuid", jpeg())).status).toBe(404);
      expect(await listContentAssets(db, theirs.organisationId, { clientId: theirs.clientId })).toHaveLength(0);
    });
  });
});
