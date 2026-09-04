import { describe, expect, it, vi } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import type { BossSender } from "./dispatch-event.js";
import { OUTBOUND_GIVE_UP_AFTER_MS, runOutboundSweep } from "./outbound-sweep.js";

const LATER = new Date(Date.now() + 5 * 60_000);

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
