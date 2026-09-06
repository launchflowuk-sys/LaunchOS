import { randomUUID } from "node:crypto";
import { listPushSubscriptions } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

type FakeSession = { userId: string; email: string; organisationId: string; role: "owner" | "staff" } | null;

let currentDb: Db | undefined;
let currentSession: FakeSession = null;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));
vi.mock("@/lib/session", () => ({ getSession: async () => currentSession }));

import { DELETE, POST } from "./route.js";

const ENDPOINT = "http://localhost/api/push/subscribe";

async function seed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `push-route-${randomUUID()}` }).returning();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: `o-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "owner", status: "active" });
  return { organisationId: org!.id, userId };
}

function req(method: "POST" | "DELETE", body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(ENDPOINT, {
    method,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers },
    body: text,
  });
}

const subscription = (endpoint = `https://push.example/send/${randomUUID()}`) => ({
  endpoint,
  keys: { p256dh: "BPUBLIC", auth: "AUTH" },
});

describe("POST/DELETE /api/push/subscribe", () => {
  afterEach(() => {
    currentDb = undefined;
    currentSession = null;
  });

  it("refuses with 401 when nobody is signed in, before touching the database", async () => {
    const res = await POST(req("POST", subscription()));
    expect(res.status).toBe(401);
  });

  it("saves this device for the signed-in member and removes it again", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, userId } = await seed(db);
      currentSession = { userId, email: "o@example.test", organisationId, role: "owner" };
      const sub = subscription();

      const saved = await POST(req("POST", sub, { "user-agent": "Safari iOS 19" }));
      expect(saved.status).toBe(200);
      const rows = await listPushSubscriptions(db, organisationId, { userId });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.endpoint).toBe(sub.endpoint);
      expect(rows[0]?.userAgent).toBe("Safari iOS 19");

      const removed = await DELETE(req("DELETE", { endpoint: sub.endpoint }));
      expect(removed.status).toBe(200);
      expect(await listPushSubscriptions(db, organisationId, { userId })).toHaveLength(0);
    });
  });

  it("rejects a body that is not a subscription", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const { organisationId, userId } = await seed(db);
      currentSession = { userId, email: "o@example.test", organisationId, role: "owner" };

      expect((await POST(req("POST", { endpoint: "not-a-url", keys: {} }))).status).toBe(400);
      expect((await POST(req("POST", "{not json"))).status).toBe(400);
      expect((await POST(req("POST", "x".repeat(9000)))).status).toBe(413);
      expect(await listPushSubscriptions(db, organisationId, { userId })).toHaveLength(0);
    });
  });

  it("will not remove another member's device", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const owner = await seed(db);
      const other = await seed(db);
      const sub = subscription();
      currentSession = { userId: owner.userId, email: "o@example.test", organisationId: owner.organisationId, role: "owner" };
      expect((await POST(req("POST", sub))).status).toBe(200);

      currentSession = { userId: other.userId, email: "x@example.test", organisationId: other.organisationId, role: "owner" };
      expect((await DELETE(req("DELETE", { endpoint: sub.endpoint }))).status).toBe(404);
      expect(await listPushSubscriptions(db, owner.organisationId, { userId: owner.userId })).toHaveLength(1);
    });
  });
});
