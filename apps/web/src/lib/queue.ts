import { setEnqueue, type DomainEvent } from "@launchos/core";
import { QUEUE, ensureQueues, type QueueName } from "@launchos/core/queue";
import PgBoss from "pg-boss";

/**
 * `next dev` re-evaluates this module whenever something it imports is
 * recompiled, so a module-scope cache would start a fresh pg-boss instance per
 * edit and leak the previous one's Postgres connections until the server runs
 * out. `globalThis` survives module re-evaluation, so development keeps exactly
 * one instance per process; production never recompiles and behaves as before.
 */
const globalForQueue = globalThis as typeof globalThis & { __launchosBoss?: Promise<PgBoss> };

let bossPromise: Promise<PgBoss> | undefined;
let installed = false;

function getBoss(url: string): Promise<PgBoss> {
  if (process.env.NODE_ENV !== "production") bossPromise ??= globalForQueue.__launchosBoss;
  // Cached as a promise so two concurrent requests share one pg-boss instance.
  bossPromise ??= (async () => {
    const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
    boss.on("error", (e) => console.error("pg-boss error (web)", e));
    await boss.start();
    // Same topology as the worker, from the same table (@launchos/core). Both
    // processes must create queues with the same policy: pg-boss's create_queue
    // ignores conflicts, so a queue this process created with the default
    // policy would keep it forever and silently disable the dedupe the send
    // sites below rely on.
    await ensureQueues(boss);
    return boss;
  })();
  if (process.env.NODE_ENV !== "production") globalForQueue.__launchosBoss = bossPromise;
  return bossPromise;
}

/**
 * Sends a job straight onto a named pg-boss queue from the web process. Used
 * for jobs the web app addresses by queue name directly, bypassing the generic
 * domain.event bus below. The name is a `QueueName`, so a queue this process
 * sends to is always one `ensureQueues` created with its intended policy.
 */
export async function sendJob(name: QueueName, data: object, opts?: PgBoss.SendOptions): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL not set; dropping job "${name}"`, data);
    return;
  }
  const boss = await getBoss(url);
  if (opts) await boss.send(name, data, opts);
  else await boss.send(name, data);
}

/**
 * Routes domain events emitted inside the web process onto the queues the
 * worker consumes. Call it at the top of any server action that writes
 * through a core service; it is a no-op after the first call.
 */
export function installWebEnqueue(): void {
  if (installed) return;
  installed = true;
  setEnqueue(async (event: DomainEvent) => {
    // email.received, message.queued and approval.decided are addressed to a
    // specific job queue the moment the web emits them — the web already
    // knows exactly which queue it wants, so there's no reason to go via the
    // generic bus for these three. Every other event (client.created,
    // incident.opened, ...) still goes onto the single domain.event queue;
    // the worker's dispatchEvent (apps/worker/src/jobs/dispatch-event.ts) is
    // the only place those event names map to a specific job queue, so a
    // consumer added there later fires for every client, not just the ones
    // created from the worker process.
    //
    // What the singletonKey below buys: these queues are created with pg-boss's
    // `stately` policy, so a second send with the same key collapses while the
    // first job is still queued, retrying or running. It is not a permanent
    // "exactly once" — once a job has completed, the same key can be sent
    // again. Anything stronger is enforced at the domain layer (a redelivered
    // message is matched on its provider Message-ID; `resumeAgent` refuses an
    // approval that has already been decided).
    switch (event.name) {
      case "email.received":
        await sendJob(
          QUEUE.inboundMessage,
          { organisationId: event.organisationId, inbound: event.inbound },
          { singletonKey: `inbound:${event.inbound.messageId}` },
        );
        return;
      case "message.queued":
        await sendJob(
          QUEUE.outboundMessage,
          { organisationId: event.organisationId, messageId: event.messageId },
          { singletonKey: `outbound:${event.messageId}` },
        );
        return;
      case "approval.decided":
        await sendJob(
          QUEUE.agentResume,
          {
            organisationId: event.organisationId,
            runId: event.runId,
            approvalId: event.approvalId,
            decision: event.decision,
            note: event.note,
          },
          { singletonKey: `resume:${event.approvalId}` },
        );
        return;
      default: {
        const url = process.env.DATABASE_URL;
        if (!url) {
          console.error("DATABASE_URL not set; dropping domain event", event);
          return;
        }
        const boss = await getBoss(url);
        // No singletonKey: domain.event carries every event kind, and its queue
        // is deliberately left on the `standard` policy for that reason.
        await boss.send(QUEUE.domainEvent, event);
      }
    }
  });
}
