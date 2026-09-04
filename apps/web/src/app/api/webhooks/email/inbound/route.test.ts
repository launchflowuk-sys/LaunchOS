import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureEmailIdentity } from "@launchos/core";
import type { DomainEvent } from "@launchos/core";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import type { Db } from "@launchos/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { emitMock } = vi.hoisted(() => ({
  emitMock: vi.fn<(event: DomainEvent) => Promise<void>>(async () => undefined),
}));

let currentDb: Db | undefined;
vi.mock("@/lib/db", () => ({ getDb: () => currentDb! }));

vi.mock("@launchos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@launchos/core")>();
  return { ...actual, emit: emitMock };
});

import { POST } from "./route.js";

const ENDPOINT = "http://localhost/api/webhooks/email/inbound";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-launchos-inbound-secret": "test-secret", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhooks/email/inbound", () => {
  let storageDir: string;
  const originalSecret = process.env.INBOUND_EMAIL_SECRET;
  const originalStorageDir = process.env.STORAGE_DIR;

  beforeEach(async () => {
    process.env.INBOUND_EMAIL_SECRET = "test-secret";
    storageDir = await mkdtemp(join(tmpdir(), "launchos-inbound-"));
    process.env.STORAGE_DIR = storageDir;
    emitMock.mockClear();
  });

  afterEach(async () => {
    process.env.INBOUND_EMAIL_SECRET = originalSecret;
    process.env.STORAGE_DIR = originalStorageDir;
    await rm(storageDir, { recursive: true, force: true });
  });

  it("rejects a request with a wrong secret", async () => {
    const res = await POST(req({ to: ["a@b.com"] }, { "x-launchos-inbound-secret": "wrong" }));
    expect(res.status).toBe(401);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no secret header", async () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["a@b.com"] }),
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
  });

  it("rejects a body that is not valid JSON", async () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-launchos-inbound-secret": "test-secret" },
      body: "{not json",
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
  });

  it("rejects a payload with no recipient", async () => {
    const res = await POST(req({ from: "a@b.com", subject: "s", text: "t", messageId: "<1@x>" }));
    expect(res.status).toBe(422);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("queues the email against the client's own organisation when the recipient matches an email identity", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const [org] = await db.insert(schema.organisations).values({ name: "Org A", slug: `org-a-${randomUUID()}` }).returning();
      // Inserted directly rather than via createClient(): that service emits
      // client.created itself, through packages/core's own relative import of
      // emit — a different module reference than the "@launchos/core" specifier
      // mocked above, so it would bypass emitMock and hit a real pg-boss queue.
      const [client] = await db
        .insert(schema.clients)
        .values({ organisationId: org!.id, name: "Client A", slug: `client-a-${randomUUID()}` })
        .returning();
      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id });

      const res = await POST(
        req({
          to: [identity.address],
          from: "customer@example.com",
          subject: "Site slow",
          text: "Pages take 20 seconds.",
          messageId: `<manual-${randomUUID()}@example.com>`,
          attachments: [{ name: "log.txt", contentType: "text/plain", contentBase64: Buffer.from("hello").toString("base64") }],
        }),
      );

      expect(res.status).toBe(202);
      const json = (await res.json()) as { queued: boolean };
      expect(json.queued).toBe(true);
      expect(emitMock).toHaveBeenCalledTimes(1);
      const [event] = emitMock.mock.calls[0]!;
      if (event.name !== "email.received") throw new Error(`expected email.received, got ${event.name}`);
      expect(event.organisationId).toBe(org!.id);
      expect(event.inbound.attachments).toHaveLength(1);
      expect(event.inbound.attachments[0]!.url).toContain(`/api/attachments/${org!.id}/`);
    });
  });

  it("falls back to the oldest active organisation when no identity matches the recipient", async () => {
    await withTestDb(async (db) => {
      currentDb = db;
      const [org] = await db.insert(schema.organisations).values({ name: "Org B", slug: `org-b-${randomUUID()}` }).returning();
      const [client] = await db
        .insert(schema.clients)
        .values({ organisationId: org!.id, name: "Client B", slug: `client-b-${randomUUID()}` })
        .returning();
      await ensureEmailIdentity(db, org!.id, { clientId: client!.id });

      const [oldest] = await db
        .select({ id: schema.organisations.id })
        .from(schema.organisations)
        .where(eq(schema.organisations.status, "active"))
        .orderBy(asc(schema.organisations.createdAt))
        .limit(1);

      const res = await POST(
        req({
          to: ["unknown@nowhere.test"],
          from: "customer@example.com",
          subject: "Hi",
          text: "Hello",
          messageId: `<manual-${randomUUID()}@example.com>`,
        }),
      );

      expect(res.status).toBe(202);
      expect(emitMock).toHaveBeenCalledTimes(1);
      const [event] = emitMock.mock.calls[0]!;
      expect(event.organisationId).toBe(oldest!.id);
    });
  });
});
