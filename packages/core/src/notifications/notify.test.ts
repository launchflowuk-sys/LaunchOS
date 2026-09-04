import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { countUnreadNotifications, listNotifications, markAllNotificationsRead, markNotificationRead } from "./list-notifications.js";
import { notify, notifyOwner } from "./notify.js";

async function makeOrgWithOwner(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const id = crypto.randomUUID();
  const [owner] = await db
    .insert(schema.user)
    .values({ id, name: "Owner", email: `owner-${id}@example.test`, emailVerified: true })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner" });
  return { org: org!, owner: owner! };
}

describe("notifications", () => {
  it("notifies the owner, counts unread and marks one read", async () => {
    await withTestDb(async (db) => {
      const { org, owner } = await makeOrgWithOwner(db);

      const first = await notifyOwner(db, org.id, { kind: "ticket.created", title: "New ticket", link: "/tickets" });
      expect(first?.userId).toBe(owner.id);
      await notify(db, org.id, { userId: owner.id, kind: "site.down", title: "Site down" });

      expect(await countUnreadNotifications(db, org.id, owner.id)).toBe(2);
      const unread = await listNotifications(db, org.id, { userId: owner.id, unreadOnly: true });
      expect(unread).toHaveLength(2);

      const read = await markNotificationRead(db, org.id, { userId: owner.id, notificationId: first!.id });
      expect(read?.readAt).toBeInstanceOf(Date);
      expect(await countUnreadNotifications(db, org.id, owner.id)).toBe(1);
    });
  });

  it("returns null when the organisation has no owner", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      expect(await notifyOwner(db, org!.id, { kind: "x", title: "y" })).toBeNull();
    });
  });

  it("refuses to notify a user who is not a member of the organisation", async () => {
    await withTestDb(async (db) => {
      const { org } = await makeOrgWithOwner(db);
      await expect(notify(db, org.id, { userId: "stranger", kind: "x", title: "y" })).rejects.toThrow(
        "member stranger not found in organisation",
      );
    });
  });

  it("markAllNotificationsRead marks only the given user's unread notifications", async () => {
    await withTestDb(async (db) => {
      const { org, owner } = await makeOrgWithOwner(db);
      const otherId = crypto.randomUUID();
      const [other] = await db
        .insert(schema.user)
        .values({ id: otherId, name: "Other", email: `other-${otherId}@example.test`, emailVerified: true })
        .returning();
      await db.insert(schema.organisationMembers).values({ organisationId: org.id, userId: other!.id, role: "staff" });

      await notify(db, org.id, { userId: owner.id, kind: "a", title: "A" });
      await notify(db, org.id, { userId: owner.id, kind: "b", title: "B" });
      await notify(db, org.id, { userId: other!.id, kind: "c", title: "C" });

      const marked = await markAllNotificationsRead(db, org.id, owner.id);
      expect(marked).toBe(2);

      const ownerNotifications = await listNotifications(db, org.id, { userId: owner.id });
      expect(ownerNotifications.every((n) => n.readAt !== null)).toBe(true);

      const otherNotifications = await listNotifications(db, org.id, { userId: other!.id });
      expect(otherNotifications.every((n) => n.readAt === null)).toBe(true);
    });
  });

  it("orders notifications that share a created_at deterministically", async () => {
    await withTestDb(async (db) => {
      const { org, owner } = await makeOrgWithOwner(db);
      // Several notifications written in one transaction share a timestamp;
      // `created_at` alone is then not a total order and the bell shuffles them
      // between requests. The `id desc` tie-break is what makes this stable.
      const createdAt = new Date("2026-09-04T10:00:00.000Z");
      await db.insert(schema.notifications).values(
        ["A", "B", "C"].map((title) => ({
          organisationId: org.id,
          userId: owner.id,
          kind: "same-instant",
          title,
          createdAt,
        })),
      );

      const first = await listNotifications(db, org.id, { userId: owner.id });
      const second = await listNotifications(db, org.id, { userId: owner.id });
      const ids = first.map((n) => n.id);
      expect(ids).toHaveLength(3);
      expect(second.map((n) => n.id)).toEqual(ids);
      expect([...ids].sort().reverse()).toEqual(ids);
    });
  });
});
