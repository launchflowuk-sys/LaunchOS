import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import { and, eq } from "drizzle-orm";
import { MockEmailAdapter } from "@launchos/channels";
import { PORTAL_REPLY_NOTICE_KIND } from "./courtesy-notice.js";
import { MAX_SEND_ATTEMPTS, sendQueuedMessage } from "./send-queued-message.js";

const BRAND_ENV = { APP_URL: "https://os.launchflow.test", SUPPORT_EMAIL_DOMAIN: "support.test" };

/** An adapter that refuses every send, the way a relay rejecting with 4xx does. */
const refusing: EmailAdapter = {
  name: "smtp",
  send: async () => {
    throw new Error("550 relay refused");
  },
};

/** An organisation with an owner (so `notifyOwner` has somewhere to go), a client and a thread. */
async function thread(db: Db, overrides: { toEmail?: string; withTicket?: boolean; body?: string; metadata?: Record<string, unknown> } = {}) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `send-${crypto.randomUUID()}` }).returning();
  const userId = crypto.randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: `owner-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId, role: "owner" });
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `c-${crypto.randomUUID()}` }).returning();
  const [conversation] = await db.insert(schema.conversations)
    .values({ organisationId: org!.id, clientId: client!.id, subject: "Hosting" }).returning();
  let ticketId: string | null = null;
  if (overrides.withTicket) {
    const [ticket] = await db.insert(schema.tickets).values({
      organisationId: org!.id, clientId: client!.id, conversationId: conversation!.id,
      subject: "Hosting", clientVisible: true,
    }).returning();
    ticketId = ticket!.id;
    await db.update(schema.conversations)
      .set({ ticketId })
      .where(eq(schema.conversations.id, conversation!.id));
  }
  const [message] = await db.insert(schema.messages).values({
    organisationId: org!.id,
    conversationId: conversation!.id,
    direction: "outbound",
    authorKind: "user",
    body: overrides.body ?? "Thanks — looking into it now.",
    fromEmail: "support@launchflow.test",
    toEmail: overrides.toEmail ?? "jo@client.test",
    subject: "Re: Hosting",
    status: "queued",
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  }).returning();
  return { organisationId: org!.id, userId, clientId: client!.id, conversationId: conversation!.id, messageId: message!.id, ticketId };
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

  // `toEmail` is copied off an inbound message's From header and `lastError` is
  // whatever the relay said, so both are client-controlled and neither is
  // bounded by the column. `recordActivity` caps title at 200 and body at 4000:
  // an over-long one used to throw out of the exhausted branch, pg-boss retried,
  // `claim()` refused the now-`failed` row — and the give-up was announced
  // nowhere at all, on a row `outbound.sweep` never looks at.
  it("still announces a give-up when the address and the error are far too long", async () => {
    await withTestDb(async (db) => {
      const address = `${"a".repeat(300)}@client.test`;
      const where = await thread(db, { toEmail: address });
      const verbose: EmailAdapter = {
        name: "smtp",
        send: async () => {
          throw new Error(`550 ${"relay refused ".repeat(600)}`);
        },
      };

      let last;
      for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
        last = await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, verbose, {})
          .catch(() => undefined);
      }

      // The failed state is recorded, and the announcement is not lost with it.
      expect(last?.status).toBe("failed");
      const [activity] = await db.select().from(schema.activityEvents)
        .where(and(
          eq(schema.activityEvents.organisationId, where.organisationId),
          eq(schema.activityEvents.kind, "message.send_failed"),
        ));
      expect(activity).toBeDefined();
      expect(activity!.title.length).toBeLessThanOrEqual(200);
      expect(activity!.title).toContain("aaa");
      expect(activity!.body!.length).toBeLessThanOrEqual(4000);

      const [notification] = await db.select().from(schema.notifications)
        .where(and(
          eq(schema.notifications.organisationId, where.organisationId),
          eq(schema.notifications.kind, "message.send_failed"),
        ));
      expect(notification).toBeDefined();
      expect(notification!.title.length).toBeLessThanOrEqual(200);
    });
  });
});

describe("sendQueuedMessage branded email", () => {
  it("sends both halves, headed by the case subject, with a button to the case", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db, { withTicket: true });
      const adapter = new MockEmailAdapter();

      await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, adapter, BRAND_ENV);

      const [sent] = adapter.sent;
      // The heading is the conversation's subject, not the message's "Re: ...".
      expect(sent!.html).toContain("Hosting");
      expect(sent!.html).toContain("Thanks");
      expect(sent!.html).toContain("View your case");
      expect(sent!.html).toContain(`https://os.launchflow.test/portal/support/${where.ticketId}`);
      expect(sent!.html).toContain("Powered by LaunchFlow");
      // The client's own support identity is the address in the footer, so a
      // reply to it threads back onto this case.
      expect(sent!.html).toContain("support@launchflow.test");
      expect(sent!.text).toContain("Thanks");
      expect(sent!.text).toContain(`https://os.launchflow.test/portal/support/${where.ticketId}`);
    });
  });

  it("escapes a reply body, so nothing a client wrote can become markup", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db, { body: '<script>alert("x")</script> & co' });
      const adapter = new MockEmailAdapter();

      await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, adapter, BRAND_ENV);

      expect(adapter.sent[0]!.html).not.toContain("<script>");
      expect(adapter.sent[0]!.html).toContain("&lt;script&gt;");
    });
  });

  it("gives the courtesy notice its own heading and shows its link once, as a button", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db, { withTicket: true, metadata: { kind: PORTAL_REPLY_NOTICE_KIND, round: 1 } });
      // The body replyToConversation composes: the notice text, then the portal
      // URL on a line of its own, because that row is also the record of what
      // the client was told.
      const caseUrl = `https://os.launchflow.test/portal/support/${where.ticketId}`;
      await db.update(schema.messages)
        .set({ body: `LaunchFlow has replied to your support case. Sign in to the portal to read it.

${caseUrl}` })
        .where(eq(schema.messages.id, where.messageId));

      const adapter = new MockEmailAdapter();
      await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, adapter, BRAND_ENV);

      const html = adapter.sent[0]!.html!;
      expect(html).toContain("Read the reply");
      expect(html).toContain("Sign in to the portal to read it.");
      // Once, as the button's href — not a second time as a paragraph of text.
      expect(html.split(caseUrl).length - 1).toBe(1);
    });
  });

  it("sends without a button when the thread has no case behind it", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      const adapter = new MockEmailAdapter();

      await sendQueuedMessage(db, where.organisationId, { messageId: where.messageId }, adapter, BRAND_ENV);

      expect(adapter.sent[0]!.html).not.toContain("View your case");
      expect(adapter.sent[0]!.html).toContain("Hosting");
    });
  });
});
