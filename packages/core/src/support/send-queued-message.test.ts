import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import { and, eq } from "drizzle-orm";
import { MAX_SEND_ATTEMPTS, sendQueuedMessage } from "./send-queued-message.js";

/** An adapter that refuses every send, the way a relay rejecting with 4xx does. */
const refusing: EmailAdapter = {
  name: "smtp",
  send: async () => {
    throw new Error("550 relay refused");
  },
};

/** An organisation with an owner (so `notifyOwner` has somewhere to go), a client and a thread. */
async function thread(db: Db) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `send-${crypto.randomUUID()}` }).returning();
  const userId = crypto.randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: `owner-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "owner" });
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `c-${crypto.randomUUID()}` }).returning();
  const [conversation] = await db.insert(schema.conversations)
    .values({ organisationId: org!.id, clientId: client!.id, subject: "Hosting" }).returning();
  const [message] = await db.insert(schema.messages).values({
    organisationId: org!.id,
    conversationId: conversation!.id,
    direction: "outbound",
    authorKind: "user",
    body: "Thanks — looking into it now.",
    fromEmail: "support@launchflow.test",
    toEmail: "jo@client.test",
    subject: "Re: Hosting",
    status: "queued",
  }).returning();
  return { organisationId: org!.id, userId, clientId: client!.id, conversationId: conversation!.id, messageId: message!.id };
}

/** Drives the send until the attempts are spent, the way pg-boss retries would. */
async function exhaust(db: Db, where: { organisationId: string; messageId: string }) {
  let last;
  for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
    // Every attempt but the last rethrows so pg-boss retries it.
    last = await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, refusing, {})
      .catch(() => undefined);
  }
  return last;
}

describe("sendQueuedMessage give-up", () => {
  it("tells the owner and the client timeline when a reply has spent every attempt", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);

      const failed = await exhaust(db, where);

      expect(failed?.status).toBe("failed");
      const activity = await db.select().from(schema.activityEvents)
        .where(and(
          eq(schema.activityEvents.organisationId, where.organisationId),
          eq(schema.activityEvents.kind, "message.send_failed"),
        ));
      expect(activity).toHaveLength(1);
      expect(activity[0]!.clientId).toBe(where.clientId);
      expect(activity[0]!.link).toBe(`/inbox/${where.conversationId}`);
      expect(activity[0]!.body).toContain("550 relay refused");

      const notifications = await db.select().from(schema.notifications)
        .where(and(
          eq(schema.notifications.organisationId, where.organisationId),
          eq(schema.notifications.kind, "message.send_failed"),
        ));
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.userId).toBe(where.userId);
    });
  });

  it("announces once — a second delivery of the same job adds nothing", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      await exhaust(db, where);

      // The message is `failed` now, so the claim is refused and nothing runs.
      // Re-queue it to prove the marker, not the status, is what stops a second
      // announcement.
      await db.update(schema.messages).set({ status: "queued" })
        .where(eq(schema.messages.id, where.messageId));
      await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, refusing, {})
        .catch(() => undefined);

      const activity = await db.select().from(schema.activityEvents)
        .where(eq(schema.activityEvents.kind, "message.send_failed"));
      const notifications = await db.select().from(schema.notifications)
        .where(eq(schema.notifications.kind, "message.send_failed"));
      expect(activity).toHaveLength(1);
      expect(notifications).toHaveLength(1);
    });
  });

  it("says nothing while attempts remain, so a transient failure is not an alert", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);

      await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, refusing, {})
        .catch(() => undefined);

      const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, where.messageId));
      expect(message!.status).toBe("queued");
      expect(await db.select().from(schema.notifications)
        .where(eq(schema.notifications.kind, "message.send_failed"))).toHaveLength(0);
    });
  });
});
