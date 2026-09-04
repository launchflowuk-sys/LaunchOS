import { setEnqueue, type DomainEvent } from "@launchos/core";
import { JOB_RETRY, QUEUE, ensureQueues, type QueueName } from "@launchos/core/queue";
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
    // pg-boss resolves a job's retry limit against the *sending* instance's
    // constructor config when the queue row has none, so without JOB_RETRY
    // here the whole interactive path (inbound/outbound mail, agent resume,
    // payments webhook, domain events) would retry twice with no delay while
    // the worker's own jobs retried five times with backoff.
    const boss = new PgBoss({ connectionString: url, schema: "pgboss", ...JOB_RETRY });
    boss.on("error", (e) => console.error("pg-boss error (web)", e));
    await boss.start();
    // Same topology as the worker, from the same table (@launchos/core). Both
    // processes must create queues with the same policy and retry settings:
    // pg-boss's create_queue ignores conflicts, so a queue this process created
    // with the default policy would keep it forever and silently disable the
    // dedupe the send sites below rely on.
    await ensureQueues(boss);
    return boss;
  })().catch((error: unknown) => {
    // A rejected promise is not nullish, so without this `??=` would pin the
    // failure for the life of the process: one bad `boss.start()` at deploy
    // time and every webhook, inbound email and approval would fail until a
    // restart. Drop the cache so the next request tries again.
    bossPromise = undefined;
    if (process.env.NODE_ENV !== "production") delete globalForQueue.__launchosBoss;
    throw error;
  });
  if (process.env.NODE_ENV !== "production") globalForQueue.__launchosBoss = bossPromise;
  return bossPromise;
}

/**
 * Sends a job straight onto a named pg-boss queue from the web process. Used
 * for jobs the web app addresses by queue name directly, bypassing the generic
 * domain.event bus below. The name is a `QueueName`, so a queue this process
 * sends to is always one `ensureQueues` created with its intended policy.
 *
 * Returns pg-boss's job id, or `null` when the send was deduped away (the
 * insert is `ON CONFLICT DO NOTHING`). A dropped send is logged rather than
 * swallowed: it is the difference between "already queued" and "silently lost"
 * and the caller — the Stripe route especially — has no other way to tell.
 *
 * A send that cannot happen at all **throws**. It used to log and return
 * `null`, which is indistinguishable from a dedupe: a caller that had already
 * committed a database change (an approval claimed for a decision, say) would
 * carry on believing the work was queued when nothing was. Callers must be
 * able to undo their own write when the enqueue fails, and that needs an error.
 */
export async function sendJob(name: QueueName, data: object, opts?: PgBoss.SendOptions): Promise<string | null> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL is not set; cannot queue "${name}"`);
  const boss = await getBoss(url);
  const jobId = opts ? await boss.send(name, data, opts) : await boss.send(name, data);
  if (jobId === null) {
    console.info({ queue: name, singletonKey: opts?.singletonKey }, "job deduped; an identical job is already queued");
  }
  return jobId;
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
    // What the singletonKey below buys, exactly: these queues are created with
    // pg-boss's `short` policy, so a duplicate is collapsed only while the
    // first job is still queued. The moment the worker picks that job up the
    // key is free again — this is not "exactly once", not even for the
    // duration of the run. Anything stronger is enforced at the domain layer
    // (a redelivered message is matched on its provider Message-ID;
    // `resumeAgent` refuses an approval that has already been decided).
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
      default:
        // No singletonKey: domain.event carries every event kind, and its queue
        // is deliberately left on the `standard` policy for that reason. Goes
        // through sendJob so a bus that cannot be reached throws like every
        // other send here — a dropped client.created would mean a client with
        // no onboarding tasks and a success toast.
        await sendJob(QUEUE.domainEvent, event);
        return;
    }
  });
}
