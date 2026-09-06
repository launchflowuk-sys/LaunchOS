import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockPushAdapter } from "@launchos/channels";
import { listPushSubscriptions, notifyOwner, savePushSubscription } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { handlePushSend, pushPayloadFor, pushTagFor } from "./push-send.js";

const quiet = { info() {}, warn() {} };
const env = { APP_URL: "https://os.launchflow.test/" } as NodeJS.ProcessEnv;

async function organisation(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `push-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  return { orgId: org!.id, ownerId };
}

function device(n: number) {
  return { endpoint: `https://push.example.test/send/${n}-${randomUUID()}`, p256dh: `p256dh-${n}`, auth: `auth-${n}` };
}

async function urgentNotification(db: Db, orgId: string) {
  const row = await notifyOwner(db, orgId, { kind: "incident.opened", title: "Site down: grayscabline.co.uk", body: "Opened just now", link: "/incidents/1" });
  if (row === null) throw new Error("fixture: the organisation has no owner to notify");
  return row;
}

describe("pushPayloadFor", () => {
  it("carries the title and body, makes the link absolute, and tags by notification id", () => {
    const payload = pushPayloadFor({ id: "n1", title: "T", body: "B", link: "/incidents/1" }, env);
    expect(payload).toEqual({ title: "T", body: "B", url: "https://os.launchflow.test/incidents/1", tag: pushTagFor("n1") });
    expect(pushPayloadFor({ id: "n1", title: "T", body: null, link: null }, env)).toMatchObject({ body: "", url: "https://os.launchflow.test" });
    expect(pushPayloadFor({ id: "n1", title: "T", body: null, link: "https://elsewhere.test/x" }, env).url).toBe("https://elsewhere.test/x");
  });
});

describe("handlePushSend", () => {
  it("sends the notification to every device the user has and stamps each subscription used", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await organisation(db);
      await savePushSubscription(db, orgId, { userId: ownerId, ...device(1) });
      await savePushSubscription(db, orgId, { userId: ownerId, ...device(2) });
      const notification = await urgentNotification(db, orgId);
      const push = new MockPushAdapter();

      const result = await handlePushSend({ db, push, env, logger: quiet }, { organisationId: orgId, notificationId: notification.id, userId: ownerId });

      expect(result).toEqual({ outcome: "delivered", sent: 2, failed: 0, gone: 0 });
      expect(push.sent).toHaveLength(2);
      expect(push.sent[0]!.payload).toEqual({
        title: "Site down: grayscabline.co.uk", body: "Opened just now", url: "https://os.launchflow.test/incidents/1", tag: pushTagFor(notification.id),
      });
      expect(push.sent[0]!.subscription.keys).toEqual({ p256dh: "p256dh-1", auth: "auth-1" });
      const subscriptions = await listPushSubscriptions(db, orgId, { userId: ownerId });
      expect(subscriptions.every((s) => s.lastUsedAt !== null && s.failedAt === null)).toBe(true);
    });
  });

  it("removes a subscription the push service no longer knows and stamps a failing one, without throwing", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await organisation(db);
      const gone = device(1);
      const flaky = device(2);
      const fine = device(3);
      for (const d of [gone, flaky, fine]) await savePushSubscription(db, orgId, { userId: ownerId, ...d });
      const notification = await urgentNotification(db, orgId);
      const push = new MockPushAdapter();
      push.failEndpoint(gone.endpoint, 410);
      push.failEndpoint(flaky.endpoint, 500);

      const result = await handlePushSend({ db, push, env, logger: quiet }, { organisationId: orgId, notificationId: notification.id, userId: ownerId });

      expect(result).toEqual({ outcome: "delivered", sent: 1, failed: 1, gone: 1 });
      const remaining = await listPushSubscriptions(db, orgId, { userId: ownerId });
      expect(remaining.map((s) => s.endpoint).sort()).toEqual([flaky.endpoint, fine.endpoint].sort());
      expect(remaining.find((s) => s.endpoint === flaky.endpoint)!.failedAt).not.toBeNull();
      expect(remaining.find((s) => s.endpoint === fine.endpoint)!.lastUsedAt).not.toBeNull();
      const [expired] = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.action, "push_subscription.expired")));
      expect(expired).toBeDefined();
    });
  });

  it("is a no-op with a warning for a notification that never committed, after a short re-read, and for a user with no devices", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await organisation(db);
      const push = new MockPushAdapter();
      const sleep = vi.fn(async () => undefined);
      const logger = { info() {}, warn: vi.fn() };

      const missing = await handlePushSend(
        { db, push, env, logger, readAttempts: 3, readDelayMs: 10, sleep },
        { organisationId: orgId, notificationId: randomUUID(), userId: ownerId },
      );
      expect(missing).toEqual({ outcome: "no_notification", sent: 0, failed: 0, gone: 0 });
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ organisationId: orgId }), expect.stringMatching(/notification not found/));

      const notification = await urgentNotification(db, orgId);
      const nobody = await handlePushSend({ db, push, env, logger: quiet }, { organisationId: orgId, notificationId: notification.id, userId: ownerId });
      expect(nobody).toEqual({ outcome: "no_subscriptions", sent: 0, failed: 0, gone: 0 });
      expect(push.sent).toHaveLength(0);
    });
  });

  it("never sends another organisation's notification, nor one addressed to a different user", async () => {
    await withTestDb(async (db) => {
      const mine = await organisation(db);
      const theirs = await organisation(db);
      await savePushSubscription(db, mine.orgId, { userId: mine.ownerId, ...device(1) });
      const foreign = await urgentNotification(db, theirs.orgId);
      const push = new MockPushAdapter();

      const crossOrg = await handlePushSend(
        { db, push, env, logger: quiet, readAttempts: 1 },
        { organisationId: mine.orgId, notificationId: foreign.id, userId: mine.ownerId },
      );
      expect(crossOrg.outcome).toBe("no_notification");

      const mineNotice = await urgentNotification(db, mine.orgId);
      const wrongUser = await handlePushSend(
        { db, push, env, logger: quiet },
        { organisationId: mine.orgId, notificationId: mineNotice.id, userId: theirs.ownerId },
      );
      expect(wrongUser.outcome).toBe("no_notification");
      expect(push.sent).toHaveLength(0);
    });
  });
});
