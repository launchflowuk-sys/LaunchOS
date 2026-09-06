import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { notify } from "../notifications/notify.js";
import { listPushSubscriptions, recordPushDelivery, removePushSubscription, savePushSubscription } from "./subscriptions.js";
import { URGENT_NOTIFICATION_KINDS, pushForNotification } from "./urgent.js";

async function seed(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `push-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  return { orgId: org!.id, ownerId };
}

const endpoint = () => `https://push.example/send/${randomUUID()}`;
const keys = { p256dh: "BPUBLIC", auth: "AUTH" };

afterEach(() => setEnqueue(async () => {}));

describe("urgent kinds", () => {
  it("names the kinds that reach the phone and the send_failed family", () => {
    for (const kind of URGENT_NOTIFICATION_KINDS) expect(pushForNotification(kind)).toBe(true);
    expect(pushForNotification("invoice.send_failed")).toBe(true);
    expect(pushForNotification("task.assigned")).toBe(false);
    expect(pushForNotification("content_item.approval_requested")).toBe(false);
  });
});

describe("push subscriptions", () => {
  it("saves, refreshes in place on the same endpoint, lists and removes", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await seed(db);
      const ep = endpoint();
      const first = await savePushSubscription(db, orgId, { userId: ownerId, endpoint: ep, ...keys, userAgent: "Safari iOS" });
      const again = await savePushSubscription(db, orgId, { userId: ownerId, endpoint: ep, p256dh: "BNEW", auth: "AUTH2" });
      expect(again.id).toBe(first.id);
      expect(again.p256dh).toBe("BNEW");

      await savePushSubscription(db, orgId, { userId: ownerId, endpoint: endpoint(), ...keys });
      expect(await listPushSubscriptions(db, orgId, { userId: ownerId })).toHaveLength(2);

      const removed = await removePushSubscription(db, orgId, { userId: ownerId, endpoint: ep });
      expect(removed?.id).toBe(first.id);
      expect(await listPushSubscriptions(db, orgId, { userId: ownerId })).toHaveLength(1);

      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.targetType, "push_subscription")));
      expect(audits.map((a) => a.action).sort()).toEqual(["push_subscription.removed", "push_subscription.saved", "push_subscription.saved", "push_subscription.saved"]);
      // The keys never reach the audit log.
      expect(JSON.stringify(audits)).not.toContain("BNEW");
    });
  });

  it("refuses a user who is not a member and keeps one user's devices away from another", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await seed(db);
      const other = await seed(db);
      await expect(savePushSubscription(db, orgId, { userId: "stranger", endpoint: endpoint(), ...keys })).rejects.toThrow(/not found in organisation/);

      const mine = await savePushSubscription(db, orgId, { userId: ownerId, endpoint: endpoint(), ...keys });
      expect(await removePushSubscription(db, other.orgId, { userId: other.ownerId, subscriptionId: mine.id })).toBeNull();
      expect(await listPushSubscriptions(db, other.orgId, { userId: other.ownerId })).toHaveLength(0);
      expect(await recordPushDelivery(db, other.orgId, { subscriptionId: mine.id, outcome: "gone" })).toBeNull();
      expect(await listPushSubscriptions(db, orgId, { userId: ownerId })).toHaveLength(1);
    });
  });

  it("records deliveries: sent stamps last_used_at, failed stamps failed_at, gone deletes", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await seed(db);
      const sub = await savePushSubscription(db, orgId, { userId: ownerId, endpoint: endpoint(), ...keys });
      const sent = await recordPushDelivery(db, orgId, { subscriptionId: sub.id, outcome: "sent" });
      expect(sent?.lastUsedAt).toBeInstanceOf(Date);
      const failed = await recordPushDelivery(db, orgId, { subscriptionId: sub.id, outcome: "failed", error: "500" });
      expect(failed?.failedAt).toBeInstanceOf(Date);
      const gone = await recordPushDelivery(db, orgId, { subscriptionId: sub.id, outcome: "gone", error: "410 Gone" });
      expect(gone?.id).toBe(sub.id);
      expect(await listPushSubscriptions(db, orgId, { userId: ownerId })).toHaveLength(0);
      const [audit] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, orgId), eq(schema.auditLog.action, "push_subscription.expired")));
      expect(audit).toBeDefined();
    });
  });
});

describe("notify() and push", () => {
  it("emits push.requested for an urgent kind only when the user has a device, never for a quiet kind", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await seed(db);
      const events: DomainEvent[] = [];
      setEnqueue(async (event) => { events.push(event); });

      await notify(db, orgId, { userId: ownerId, kind: "incident.opened", title: "Site down" });
      expect(events).toHaveLength(0);

      await savePushSubscription(db, orgId, { userId: ownerId, endpoint: endpoint(), ...keys });
      const urgent = await notify(db, orgId, { userId: ownerId, kind: "incident.opened", title: "Site down again" });
      expect(events).toEqual([{ name: "push.requested", organisationId: orgId, notificationId: urgent.id, userId: ownerId }]);

      await notify(db, orgId, { userId: ownerId, kind: "task.assigned", title: "Assigned" });
      expect(events).toHaveLength(1);
    });
  });

  it("still writes the notification when the push request cannot be queued", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await seed(db);
      await savePushSubscription(db, orgId, { userId: ownerId, endpoint: endpoint(), ...keys });
      setEnqueue(async () => { throw new Error("queue down"); });
      const row = await notify(db, orgId, { userId: ownerId, kind: "worker.down", title: "Worker down" });
      expect(row.id).toBeDefined();
    });
  });
});
