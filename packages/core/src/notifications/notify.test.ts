import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { countUnreadNotifications, listNotifications, markNotificationRead } from "./list-notifications.js";
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
});
