import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listContentAssets } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type FakeClientSession = {
  userId: string; email: string; name: string; organisationId: string; clientId: string; clientName: string; role: "client_admin";
} | null;

let currentDb: Db | undefined;
let currentSession: FakeClientSession = null;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));
vi.mock("@/lib/portal-session", () => ({ getClientSession: async () => currentSession }));

import { POST } from "./route.js";

let storageDir: string;
const previousStorage = process.env.STORAGE_DIR;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "launchos-portal-assets-"));
  process.env.STORAGE_DIR = storageDir;
});

afterAll(async () => {
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  await rm(storageDir, { recursive: true, force: true });
});

async function seed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `portal-assets-${randomUUID()}` }).returning();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Client", email: `c-${userId}@example.test`, emailVerified: true });
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  return { organisationId: org!.id, userId, clientId: client!.id };
}

function upload(file: File | null): Promise<Response> {
  const form = new FormData();
  if (file) form.set("file", file);
  return POST(new Request("http://localhost/api/portal/assets", { method: "POST", body: form }));
}

describe("POST /api/portal/assets", () => {
  afterEach(() => {
    currentDb = undefined;
    currentSession = null;
  });

  it("refuses with 401 without a portal session", async () => {
    expect((await upload(new File([new Uint8Array(8)], "a.png", { type: "image/png" }))).status).toBe(401);
  });

  it("stores the photo on the session's client as a client upload", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, userId, clientId } = await seed(db);
      currentSession = {
        userId, email: "c@example.test", name: "Client", organisationId, clientId, clientName: "C", role: "client_admin",
      };

      const res = await upload(new File([new Uint8Array(16)], "shopfront.webp", { type: "image/webp" }));
      expect(res.status).toBe(200);
      const assets = await listContentAssets(db, organisationId, { clientId });
      expect(assets).toHaveLength(1);
      expect(assets[0]?.source).toBe("client");
      expect(assets[0]?.originalName).toBe("shopfront.webp");
      expect(assets[0]?.uploadedByUserId).toBe(userId);

      expect((await upload(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }))).status).toBe(415);
    });
  });
});
