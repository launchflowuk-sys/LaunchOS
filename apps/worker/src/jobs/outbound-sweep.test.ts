import { describe, expect, it, vi } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import type { BossSender } from "./dispatch-event.js";
import { CLAIM_TTL_MINUTES } from "@launchos/core";
import { OUTBOUND_GIVE_UP_AFTER_MS, runOutboundSweep } from "./outbound-sweep.js";

/**
 * Lets one test make `notifyOwner` fail for one kind. Everything else goes to
 * the real implementation and the real table, so the rest of the file is
 * untouched by this.
 */
const mocks = vi.hoisted(() => ({ failNotifyKinds: new Set<string>() }));

vi.mock("@launchos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@launchos/core")>();
  const notifyOwner: typeof actual.notifyOwner = async (db, organisationId, input) => {
    if (mocks.failNotifyKinds.has(input.kind)) throw new Error("the notifications table is unreachable");
    return actual.notifyOwner(db, organisationId, input);
  };
  return { ...actual, notifyOwner };
});

const LATER = new Date(Date.now() + 5 * 60_000);

/** Old enough that the sweep has stopped re-enqueueing and announces the give-up. */
function pastGiveUp() {
  return new Date(Date.now() - OUTBOUND_GIVE_UP_AFTER_MS - 60_000);
}

function silentLogger() {
  return { error: vi.fn(), info: vi.fn() };
}

function fakeBoss() {
  const sent: { name: string; job: unknown; opts: unknown }[] = [];
  const boss: BossSender = {
    send: (async (name: string, job: unknown, opts: unknown) => {
      sent.push({ name, job, opts });
      return "job-id";
    }) as BossSender["send"],
  };
  return { boss, sent };
}

/** An organisation with one client and one conversation to hang messages on. */
async function thread(db: Db) {
  const [org] = await db.insert(schema.organisations)
    .values({ name: "T", slug: `outbound-${crypto.randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `c-${crypto.randomUUID()}` }).returning();
  const [conversation] = await db.insert(schema.conversations)
    .values({ organisationId: org!.id, clientId: client!.id, subject: "Hosting" }).returning();
  return { organisationId: org!.id, conversationId: conversation!.id };
}

/** Somewhere for `notifyOwner` to go: an organisation with no owner swallows it. */
async function withOwner(db: Db, organisationId: string) {
  const userId = crypto.randomUUID();
  await db.insert(schema.user)
    .values({ id: userId, name: "Owner", email: `owner-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId, role: "owner" });
  return userId;
}

async function giveUpNotifications(db: Db, organisationId: string) {
  return db.select().from(schema.notifications).where(and(
    eq(schema.notifications.organisationId, organisationId),
    eq(schema.notifications.kind, "message.undelivered"),
  ));
}

/** What the give-up marker is stamped as, or undefined if it never was. */
async function giveUpMarker(db: Db, messageId: string) {
  const [row] = await db
    .select({ metadata: schema.messages.metadata })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId));
  return row!.metadata["outboundGiveUpNotifiedAt"];
}

async function message(
  db: Db,
  where: { organisationId: string; conversationId: string },
  values: Partial<typeof schema.messages.$inferInsert> = {},
) {
  const [row] = await db.insert(schema.messages).values({
    organisationId: where.organisationId,
    conversationId: where.conversationId,
    direction: "outbound",
    authorKind: "user",
    body: "Thanks — looking into it now.",
    fromEmail: "support@launchflow.test",
    toEmail: "jo@client.test",
    subject: "Re: Hosting",
    status: "queued",
    ...values,
  }).returning();
  return row!;
}

describe("runOutboundSweep", () => {
  it("re-enqueues a queued message whose outbound.message job never arrived, under the same key", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      const row = await message(db, where);
      const { boss, sent } = fakeBoss();

      await runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, LATER);

      expect(sent).toEqual([{
        name: "outbound.message",
        job: { organisationId: where.organisationId, messageId: row.id },
        // The same key the web request and dispatchEvent use, so a job already
        // queued is deduped rather than sending the reply twice.
        opts: { singletonKey: `outbound:${row.id}` },
      }]);
    });
  });

  it("leaves a message younger than the delivery window alone, so the normal path is never doubled", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      await message(db, where);
      const { boss, sent } = fakeBoss();

      // `now` is the instant of the write: the request's own enqueue has not
      // even returned yet.
      await runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, new Date());

      expect(sent).toEqual([]);
    });
  });

  it("leaves a message that is no longer queued alone", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      await message(db, where, { status: "sent" });
      await message(db, where, { status: "failed" });
      await message(db, where, { direction: "internal", status: null });
      const { boss, sent } = fakeBoss();

      await runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, LATER);

      expect(sent).toEqual([]);
    });
  });

  it("gives up on a message a day old rather than re-enqueueing it for ever", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      const row = await message(db, where);
      await db.update(schema.messages)
        .set({ createdAt: new Date(Date.now() - OUTBOUND_GIVE_UP_AFTER_MS - 60_000) })
        .where(eq(schema.messages.id, row.id));
      const { boss, sent } = fakeBoss();

      await runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, LATER);

      expect(sent).toEqual([]);
    });
  });

  it("leaves a message another worker is holding alone until its claim expires", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      const row = await message(db, where);
      // `sendQueuedMessage` takes a CLAIM_TTL_MINUTES lease before it sends;
      // re-enqueueing against a live one would only claim nothing.
      await db.update(schema.messages)
        .set({ metadata: { claimedAt: new Date().toISOString() } })
        .where(eq(schema.messages.id, row.id));
      const first = fakeBoss();

      await runOutboundSweep({ db, boss: first.boss, logger: silentLogger() }, where.organisationId, LATER);
      expect(first.sent).toEqual([]);

      // Once the lease has expired the worker holding it is presumed dead.
      await db.update(schema.messages)
        .set({ metadata: { claimedAt: new Date(Date.now() - (CLAIM_TTL_MINUTES + 1) * 60_000).toISOString() } })
        .where(eq(schema.messages.id, row.id));
      const second = fakeBoss();

      await runOutboundSweep({ db, boss: second.boss, logger: silentLogger() }, where.organisationId, LATER);
      expect(second.sent).toHaveLength(1);
    });
  });

  it("tells the owner once when a message crosses the give-up bound undelivered", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      const userId = await withOwner(db, where.organisationId);
      const row = await message(db, where);
      await db.update(schema.messages)
        .set({ createdAt: new Date(Date.now() - OUTBOUND_GIVE_UP_AFTER_MS - 60_000) })
        .where(eq(schema.messages.id, row.id));
      const { boss, sent } = fakeBoss();

      await runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, LATER);
      // A minute later the cron runs again and finds the same row.
      await runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, new Date(LATER.getTime() + 60_000));

      expect(sent).toEqual([]);
      const notifications = await giveUpNotifications(db, where.organisationId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.userId).toBe(userId);
      expect(notifications[0]!.link).toBe(`/inbox/${where.conversationId}`);
    });
  });

  it("bounds a give-up title built from a client-controlled address", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      await withOwner(db, where.organisationId);
      // `messages.to_email` is a `text` column copied off the inbound sender's
      // own `From` header, so its length is the sender's choice — and `notify`
      // validates `title` at 200 characters. Untruncated, this title is 364
      // characters, the notification throws, the marker is never stamped, and
      // the row is retried and logged every minute for the rest of its life.
      const row = await message(db, where, { toEmail: `${"a".repeat(300)}@client.test` });
      await db.update(schema.messages).set({ createdAt: pastGiveUp() }).where(eq(schema.messages.id, row.id));
      const logger = silentLogger();
      const { boss } = fakeBoss();

      await runOutboundSweep({ db, boss, logger }, where.organisationId, LATER);

      const notifications = await giveUpNotifications(db, where.organisationId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.title.length).toBeLessThanOrEqual(200);
      // Truncated, not replaced: enough of the address survives to identify it.
      expect(notifications[0]!.title).toContain("a".repeat(100));
      expect(logger.error).not.toHaveBeenCalled();
      expect(await giveUpMarker(db, row.id)).toEqual(expect.any(String));
    });
  });

  it("stamps the give-up marker even when the notification fails, so no row is retried for ever", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      await withOwner(db, where.organisationId);
      const row = await message(db, where);
      await db.update(schema.messages).set({ createdAt: pastGiveUp() }).where(eq(schema.messages.id, row.id));
      const first = silentLogger();
      mocks.failNotifyKinds.add("message.undelivered");
      try {
        await runOutboundSweep({ db, boss: fakeBoss().boss, logger: first }, where.organisationId, LATER);
      } finally {
        mocks.failNotifyKinds.clear();
      }

      // Said once, loudly, with the whole alert in the line so it is not lost.
      expect(first.error).toHaveBeenCalledTimes(1);
      expect(await giveUpMarker(db, row.id)).toEqual(expect.any(String));

      // …and the next tick a minute later is silent rather than trying again.
      const second = silentLogger();
      await runOutboundSweep(
        { db, boss: fakeBoss().boss, logger: second },
        where.organisationId,
        new Date(LATER.getTime() + 60_000),
      );
      expect(second.error).not.toHaveBeenCalled();
      expect(await giveUpNotifications(db, where.organisationId)).toHaveLength(0);
    });
  });

  it("says nothing about a message still inside the window", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      await withOwner(db, where.organisationId);
      await message(db, where);
      const { boss } = fakeBoss();

      await runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, LATER);

      expect(await giveUpNotifications(db, where.organisationId)).toHaveLength(0);
    });
  });

  it("leaves another organisation's queued message alone", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      await message(db, where);
      const other = await thread(db);
      const { boss, sent } = fakeBoss();

      await runOutboundSweep({ db, boss, logger: silentLogger() }, other.organisationId, LATER);

      expect(sent).toEqual([]);
    });
  });

  it("costs only its own item when a send throws, and still fails the job", async () => {
    await withTestDb(async (db) => {
      const where = await thread(db);
      const bad = await message(db, where);
      const good = await message(db, where);
      const sent: string[] = [];
      const boss: BossSender = {
        send: (async (_name: string, job: { messageId: string }) => {
          if (job.messageId === bad.id) throw new Error("pg-boss is down");
          sent.push(job.messageId);
          return "job-id";
        }) as BossSender["send"],
      };

      await expect(
        runOutboundSweep({ db, boss, logger: silentLogger() }, where.organisationId, LATER),
      ).rejects.toThrow(/1 of 2 failed/);
      expect(sent).toEqual([good.id]);
    });
  });
});
