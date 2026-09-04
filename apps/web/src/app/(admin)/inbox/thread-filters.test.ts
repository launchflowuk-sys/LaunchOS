import { createClient, createTicket, ensureEmailIdentity, PORTAL_REPLY_NOTICE_KIND, replyToConversation } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, asc, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { excludingCourtesyNotice, lastMessageDirection } from "./thread-filters";

const ENV = { ...process.env, SUPPORT_EMAIL_DOMAIN: "support.test", MAIL_FROM: "LaunchFlow <support@launchflow.test>" };

/**
 * A case the client raised in the portal, with a contact address on the client
 * record so a staff reply queues a real courtesy notice rather than a fixture
 * this file invented. Leaves one `inbound` message on the thread.
 */
async function seedPortalCase(db: Db) {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "T", slug: `t-${crypto.randomUUID()}` })
    .returning();
  const organisationId = org!.id;
  const client = await createClient(db, organisationId, { name: "C", email: "jo@client.test" });
  await ensureEmailIdentity(db, organisationId, { clientId: client.id }, ENV);
  const { conversation } = await createTicket(db, organisationId, {
    clientId: client.id,
    subject: "Contact form is down",
    body: "Nothing arrives.",
    severity: "medium",
    source: "portal",
    actorKind: "client",
    actorId: "portal-user-1",
  });
  // Every row written inside `withTestDb` shares one transaction's `now()`, so
  // without this the opening message and the answer are the same instant and
  // "newest" is a tie the database breaks however it likes. In production they
  // are separate transactions, minutes or days apart.
  await db
    .update(schema.messages)
    .set({ createdAt: new Date("2026-01-01T09:00:00Z") })
    .where(eq(schema.messages.conversationId, conversation.id));

  return { organisationId, client, conversation };
}

/** The message list the case screen renders — the same query, the same filter. */
function threadBodies(db: Db, organisationId: string, conversationId: string) {
  return db
    .select({ body: schema.messages.body })
    .from(schema.messages)
    .where(and(
      eq(schema.messages.conversationId, conversationId),
      eq(schema.messages.organisationId, organisationId),
      excludingCourtesyNotice(),
    ))
    .orderBy(asc(schema.messages.createdAt));
}

/** The Inbox's one column — the same correlated subquery, on one conversation. */
async function directionOf(db: Db, organisationId: string, conversationId: string) {
  const [row] = await db
    .select({ lastDirection: lastMessageDirection() })
    .from(schema.conversations)
    .where(and(
      eq(schema.conversations.id, conversationId),
      eq(schema.conversations.organisationId, organisationId),
    ));
  return row!.lastDirection;
}

describe("excludingCourtesyNotice", () => {
  it("keeps the answer on the staff thread and drops the nudge that answer queued", async () => {
    await withTestDb(async (db) => {
      const { organisationId, conversation } = await seedPortalCase(db);

      await replyToConversation(db, organisationId, {
        conversationId: conversation.id,
        body: "Fixed — the form was pointing at the old address.",
        actorKind: "user",
        actorId: "staff-1",
      });

      // The notice is real: written by the reply above, addressed to the
      // client, and sitting on the very same conversation.
      const all = await db
        .select({ body: schema.messages.body, metadata: schema.messages.metadata })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversation.id))
        .orderBy(asc(schema.messages.createdAt));
      const notice = all.find((m) => (m.metadata as { kind?: string } | null)?.kind === PORTAL_REPLY_NOTICE_KIND);
      expect(notice).toBeDefined();
      expect(notice!.body).toMatch(/Sign in to the portal/);

      // And the staff thread is the case without it: what the client asked and
      // what we answered, never the machine telling them to come and read it.
      const visible = await threadBodies(db, organisationId, conversation.id);
      expect(visible.map((m) => m.body)).toEqual([
        "Nothing arrives.",
        "Fixed — the form was pointing at the old address.",
      ]);
    });
  });

  it("keeps every ordinary message, whose metadata has no kind at all", async () => {
    await withTestDb(async (db) => {
      const { organisationId, conversation } = await seedPortalCase(db);

      // `metadata->>'kind'` is NULL on an ordinary message and `not NULL` is
      // NULL, so a filter without the `coalesce` inside `isCourtesyNotice`
      // would empty the whole thread rather than remove the one row.
      const visible = await threadBodies(db, organisationId, conversation.id);
      expect(visible.map((m) => m.body)).toEqual(["Nothing arrives."]);
    });
  });
});

describe("lastMessageDirection", () => {
  it("is inbound while the client has the last word — the Inbox's needs-reply badge", async () => {
    await withTestDb(async (db) => {
      const { organisationId, conversation } = await seedPortalCase(db);
      expect(await directionOf(db, organisationId, conversation.id)).toBe("inbound");
    });
  });

  it("is outbound once we have answered, courtesy notice and all", async () => {
    await withTestDb(async (db) => {
      const { organisationId, conversation } = await seedPortalCase(db);
      await replyToConversation(db, organisationId, {
        conversationId: conversation.id,
        body: "Looking at it now.",
        actorKind: "user",
        actorId: "staff-1",
      });
      expect(await directionOf(db, organisationId, conversation.id)).toBe("outbound");
    });
  });

  it("ignores a courtesy notice sitting on top of the client's message", async () => {
    await withTestDb(async (db) => {
      const { organisationId, conversation } = await seedPortalCase(db);

      // Explicit timestamps because the point of the test is the ordering: the
      // newest row on the thread is the nudge, the newest thing either party
      // said is the client's. Without the filter the subquery answers
      // "outbound" and the badge disappears from a thread we owe an answer on —
      // silently, with every other suite still green.
      await db.insert(schema.messages).values([
        {
          organisationId,
          conversationId: conversation.id,
          direction: "outbound",
          authorKind: "user",
          body: "Can you send a screenshot?",
          status: "sent",
          createdAt: new Date("2026-10-01T10:00:00Z"),
        },
        {
          organisationId,
          conversationId: conversation.id,
          direction: "inbound",
          authorKind: "client",
          body: "Attached.",
          createdAt: new Date("2026-10-01T11:00:00Z"),
        },
        {
          organisationId,
          conversationId: conversation.id,
          direction: "outbound",
          authorKind: "system",
          body: "LaunchFlow has replied to your support case.",
          status: "queued",
          metadata: { kind: PORTAL_REPLY_NOTICE_KIND, round: 1 },
          createdAt: new Date("2026-10-01T12:00:00Z"),
        },
      ]);

      const [newest] = await db
        .select({ metadata: schema.messages.metadata })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversation.id))
        .orderBy(desc(schema.messages.createdAt))
        .limit(1);
      expect((newest!.metadata as { kind?: string } | null)?.kind).toBe(PORTAL_REPLY_NOTICE_KIND);

      expect(await directionOf(db, organisationId, conversation.id)).toBe("inbound");
    });
  });

  it("is null on a thread that holds nothing but a notice", async () => {
    await withTestDb(async (db) => {
      const [org] = await db
        .insert(schema.organisations)
        .values({ name: "T", slug: `t-${crypto.randomUUID()}` })
        .returning();
      const organisationId = org!.id;
      const client = await createClient(db, organisationId, { name: "C" });
      const [conversation] = await db
        .insert(schema.conversations)
        .values({ organisationId, clientId: client.id, subject: "Empty", channel: "portal" })
        .returning();
      await db.insert(schema.messages).values({
        organisationId,
        conversationId: conversation!.id,
        direction: "outbound",
        authorKind: "system",
        body: "LaunchFlow has replied to your support case.",
        status: "queued",
        metadata: { kind: PORTAL_REPLY_NOTICE_KIND, round: 1 },
      });

      // NULL, not "outbound": nobody has spoken, so nothing is owed.
      expect(await directionOf(db, organisationId, conversation!.id)).toBeNull();
    });
  });
});
