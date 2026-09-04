import { JOB_RETRY, ensureQueues } from "@launchos/core/queue";
import PgBoss from "pg-boss";

// The queue names, their dedupe policies and their retry settings live in
// @launchos/core so the web process creates them identically — pg-boss's
// create_queue ignores conflicts, so whichever process boots first would
// otherwise fix them for good. Re-exported here because every worker module
// addresses queues through `QUEUE`.
export { QUEUE, dailyDedupe } from "@launchos/core/queue";
export type { QueueName } from "@launchos/core/queue";

export async function createBoss(connectionString: string) {
  // `JOB_RETRY` here is only the constructor fallback for a queue this process
  // sends to before `ensureQueues` has reached it; the queue row set below is
  // the authority, and it is the same table the web process applies.
  const boss = new PgBoss({ connectionString, schema: "pgboss", ...JOB_RETRY });
  boss.on("error", (e) => console.error("pg-boss error", e));
  await boss.start();
  await ensureQueues(boss);
  return boss;
}
