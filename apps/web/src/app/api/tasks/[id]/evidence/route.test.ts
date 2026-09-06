import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, taskEvidenceStatus } from "@launchos/core";
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
  storageDir = await mkdtemp(join(tmpdir(), "launchos-evidence-"));
  process.env.STORAGE_DIR = storageDir;
});

afterAll(async () => {
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  await rm(storageDir, { recursive: true, force: true });
});

async function seed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `evidence-route-${randomUUID()}` }).returning();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: `o-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug: `c-${randomUUID()}` }).returning();
  const task = await createTask(db, org!.id, {
    clientId: client!.id, title: "Launch the site", phase: "onboarding", kind: "other", priority: "medium",
    actorKind: "system",
  });
  return { organisationId: org!.id, userId, taskId: task.id };
}

function upload(taskId: string, file: File | null): Promise<Response> {
  const form = new FormData();
  if (file) form.set("file", file);
  const request = new Request(`http://localhost/api/tasks/${taskId}/evidence`, { method: "POST", body: form });
  return POST(request, { params: Promise.resolve({ id: taskId }) });
}

const png = (bytes = 64) => new File([new Uint8Array(bytes)], "proof.png", { type: "image/png" });

describe("POST /api/tasks/[id]/evidence", () => {
  afterEach(() => {
    currentDb = undefined;
    currentSession = null;
  });

  it("refuses with 401 when nobody is signed in", async () => {
    expect((await upload(randomUUID(), png())).status).toBe(401);
  });

  it("stores the screenshot on the task's evidence for the signed-in member", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, userId, taskId } = await seed(db);
      currentSession = { userId, email: "o@example.test", organisationId, role: "owner" };

      const res = await upload(taskId, png());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { attachment: { name: string; url: string; size: number } };
      expect(json.attachment.name).toBe("proof.png");
      expect(json.attachment.url).toMatch(new RegExp(`^/api/attachments/${organisationId}/`));

      const status = await taskEvidenceStatus(db, organisationId, taskId);
      expect(status.evidence.attachments).toHaveLength(1);
      expect(status.evidence.attachments[0]?.uploadedBy).toBe(userId);
    });
  });

  it("refuses a missing file, a non-image and an oversized one", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, userId, taskId } = await seed(db);
      currentSession = { userId, email: "o@example.test", organisationId, role: "owner" };

      expect((await upload(taskId, null)).status).toBe(400);
      expect((await upload(taskId, new File(["<html>"], "page.html", { type: "text/html" }))).status).toBe(415);
      expect((await upload(taskId, png(8 * 1024 * 1024 + 1))).status).toBe(413);
      expect((await taskEvidenceStatus(db, organisationId, taskId)).evidence.attachments).toHaveLength(0);
    });
  });

  it("is a 404 for another organisation's task", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const theirs = await seed(db);
      const ours = await seed(db);
      currentSession = { userId: ours.userId, email: "o@example.test", organisationId: ours.organisationId, role: "owner" };

      expect((await upload(theirs.taskId, png())).status).toBe(404);
      expect((await upload("not-a-uuid", png())).status).toBe(404);
      expect((await taskEvidenceStatus(db, theirs.organisationId, theirs.taskId)).evidence.attachments).toHaveLength(0);
    });
  });
});
