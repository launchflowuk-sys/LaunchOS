import { randomUUID } from "node:crypto";
import { JOB_RETRY, QUEUE, ensureQueues } from "@launchos/core/queue";
import { createDb } from "@launchos/db";
import { sql } from "drizzle-orm";
import PgBoss from "pg-boss";
import { describe, expect, it } from "vitest";

/**
 * The one test in this repo that exercises the queue topology against a real
 * pg-boss and a real Postgres.
 *
 * Everything else about `ensureQueues` is asserted against a fake `QueueAdmin`
 * we wrote ourselves, which cannot tell us the two things that actually matter:
 * whether pg-boss accepts the option shape we send it, and what its partial
 * unique indexes really do to a duplicate send. The `stately` stall this
 * replaced (a duplicate arriving while the first job was `active` aborted
 * `fetchNextJob` for the whole queue) was exactly that class of bug.
 *
 * Runs in a throwaway `pgboss_test_<random>` schema so it cannot touch the
 * `pgboss` schema the dev worker uses; the schema is dropped in `finally`.
 */

const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL or DATABASE_URL_TEST must be set for tests");
const connectionString = url;

const QUEUE_NAME = QUEUE.agentRun;

/**
 * `fetchNextJob` filters on `start_after < now()`, so a job sent this instant
 * can miss the very first fetch. Polls briefly rather than sleeping blindly.
 */
async function fetchOne(boss: PgBoss, name: string): Promise<PgBoss.Job<unknown>[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobs = await boss.fetch<unknown>(name);
    if (jobs && jobs.length > 0) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

describe("queue topology against a real pg-boss", () => {
  it("converges an existing queue's policy and collapses a duplicate only while it is queued", async () => {
    const schemaName = `pgboss_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const boss = new PgBoss({
      connectionString,
      schema: schemaName,
      // No cron thread and no maintenance thread: this test only needs the
      // queue tables and the send/fetch path.
      schedule: false,
      supervise: false,
      ...JOB_RETRY,
    });
    boss.on("error", () => { /* asserted on directly; do not crash the run */ });

    try {
      await boss.start();

      // A queue that already exists on the wrong policy — i.e. every database
      // created before this table did. `create_queue` is ON CONFLICT DO
      // NOTHING, so only `updateQueue` inside `ensureQueues` can fix it.
      await boss.createQueue(QUEUE_NAME, { name: QUEUE_NAME, policy: "standard" });
      expect((await boss.getQueue(QUEUE_NAME))?.policy).toBe("standard");

      await ensureQueues(boss);

      const converged = await boss.getQueue(QUEUE_NAME);
      expect(converged?.policy).toBe("short");
      expect(converged?.retryLimit).toBe(JOB_RETRY.retryLimit);
      expect(converged?.retryBackoff).toBe(JOB_RETRY.retryBackoff);
      // The keyless queue must not be given a singleton policy, or every
      // unrelated domain event would collapse into one job.
      expect((await boss.getQueue(QUEUE.domainEvent))?.policy).toBe("standard");

      // 1. Two sends with the same key while nothing is running: one row.
      const key = `integration:${randomUUID()}`;
      const first = await boss.send(QUEUE_NAME, { n: 1 }, { singletonKey: key });
      const second = await boss.send(QUEUE_NAME, { n: 2 }, { singletonKey: key });
      expect(first).toBeTruthy();
      expect(second).toBeNull();
      expect(await boss.getQueueSize(QUEUE_NAME)).toBe(1);

      // 2. The same key sent again while the first job is ACTIVE is accepted,
      //    and the queue keeps moving. Under `stately` this insert also
      //    succeeded, but the fetch that promoted it violated job_i3, the
      //    UPDATE aborted, and `manager.fetch` swallowed the error — measured:
      //    0 rows fetched, job left `created`, nothing logged, queue stalled.
      const active = await fetchOne(boss, QUEUE_NAME);
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(first);

      const whileActive = await boss.send(QUEUE_NAME, { n: 3 }, { singletonKey: key });
      expect(whileActive).toBeTruthy();
      expect(whileActive).not.toBe(first);

      const next = await fetchOne(boss, QUEUE_NAME);
      expect(next).toHaveLength(1);
      expect(next[0]!.id).toBe(whileActive);
      expect(next[0]!.data).toEqual({ n: 3 });
    } finally {
      await boss.stop({ graceful: false, wait: true }).catch(() => { /* best effort */ });
      const db = createDb(connectionString);
      try {
        await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      } finally {
        await (db.$client as { end: () => Promise<void> }).end();
      }
    }
  });
});
