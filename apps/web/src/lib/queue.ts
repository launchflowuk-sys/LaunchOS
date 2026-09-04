import { setEnqueue, type DomainEvent } from "@launchos/core";
import PgBoss from "pg-boss";

const QUEUE_DOMAIN_EVENT = "domain.event";

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
// Queues this process has already asked pg-boss to create. createQueue is
// idempotent, so re-calling it is only ever a wasted round trip, not a bug —
// this cache just avoids paying that cost on every send.
const createdQueues = new Set<string>();

function getBoss(url: string): Promise<PgBoss> {
  if (process.env.NODE_ENV !== "production") bossPromise ??= globalForQueue.__launchosBoss;
  // Cached as a promise so two concurrent requests share one pg-boss instance.
  bossPromise ??= (async () => {
    const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
    boss.on("error", (e) => console.error("pg-boss error (web)", e));
    await boss.start();
    await boss.createQueue(QUEUE_DOMAIN_EVENT);
    createdQueues.add(QUEUE_DOMAIN_EVENT);
    return boss;
  })();
  if (process.env.NODE_ENV !== "production") globalForQueue.__launchosBoss = bossPromise;
  return bossPromise;
}

/**
 * Sends a job straight onto a named pg-boss queue from the web process,
 * creating the queue first if this process has not seen it yet (safe even if
 * the worker already created it — createQueue is idempotent). Used for jobs
 * the web app addresses by queue name directly, bypassing the generic
 * domain.event bus below.
 */
export async function sendJob(name: string, data: object, opts?: PgBoss.SendOptions): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL not set; dropping job "${name}"`, data);
    return;
  }
  const boss = await getBoss(url);
  if (!createdQueues.has(name)) {
    await boss.createQueue(name);
    createdQueues.add(name);
  }
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
    switch (event.name) {
      case "email.received":
        await sendJob(
          "inbound.message",
          { organisationId: event.organisationId, inbound: event.inbound },
          { singletonKey: `inbound:${event.inbound.messageId}` },
        );
        return;
      case "message.queued":
        await sendJob(
          "outbound.message",
          { organisationId: event.organisationId, messageId: event.messageId },
          { singletonKey: `outbound:${event.messageId}` },
        );
        return;
      case "approval.decided":
        await sendJob(
          "agent.resume",
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
        await boss.send(QUEUE_DOMAIN_EVENT, event);
      }
    }
  });
}
