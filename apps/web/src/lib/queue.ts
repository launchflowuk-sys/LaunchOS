import { setEnqueue, type DomainEvent } from "@launchos/core";
import PgBoss from "pg-boss";

const QUEUE_DOMAIN_EVENT = "domain.event";

let bossPromise: Promise<PgBoss> | undefined;
let installed = false;

function getBoss(url: string): Promise<PgBoss> {
  // Cached as a promise so two concurrent requests share one pg-boss instance.
  bossPromise ??= (async () => {
    const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
    boss.on("error", (e) => console.error("pg-boss error (web)", e));
    await boss.start();
    await boss.createQueue(QUEUE_DOMAIN_EVENT);
    return boss;
  })();
  return bossPromise;
}

/**
 * Routes domain events emitted inside the web process onto the queue the worker
 * consumes. Call it at the top of any server action that writes through a core
 * service; it is a no-op after the first call.
 */
export function installWebEnqueue(): void {
  if (installed) return;
  installed = true;
  setEnqueue(async (event: DomainEvent) => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL not set; dropping domain event", event);
      return;
    }
    const boss = await getBoss(url);
    // Every event — including client.created — goes onto the single
    // domain.event queue. The worker's dispatchEvent (apps/worker/src/jobs/
    // dispatch-event.ts) is the only place event names map to specific job
    // queues; keeping that mapping in one spot means a consumer added there
    // later (e.g. Plan 4's ensureEmailIdentity on client.created) fires for
    // every client, not just the ones created from the worker process.
    await boss.send(QUEUE_DOMAIN_EVENT, event);
  });
}
