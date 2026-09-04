import { ensureQueues } from "@launchos/core/queue";
import PgBoss from "pg-boss";

// The queue names and their dedupe policies live in @launchos/core so the web
// process creates them identically — pg-boss's create_queue ignores conflicts,
// so whichever process boots first would otherwise fix the policy for good.
// Re-exported here because every worker module addresses queues through
// `QUEUE`.
export { QUEUE, dailyDedupe } from "@launchos/core/queue";
export type { QueueName } from "@launchos/core/queue";

export async function createBoss(connectionString: string) {
  const boss = new PgBoss({ connectionString, schema: "pgboss", retryLimit: 5, retryBackoff: true });
  boss.on("error", (e) => console.error("pg-boss error", e));
  await boss.start();
  await ensureQueues(boss);
  return boss;
}
