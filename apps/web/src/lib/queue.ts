import { notifyOwner, setEnqueue, type DomainEvent } from "@launchos/core";
import { BOSS_OPTIONS, JOB_RETRY, QUEUE, ensureQueues, type QueueName, type QueuePolicy } from "@launchos/core/queue";
import PgBoss from "pg-boss";
import { getDb } from "./db";

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
    const boss = new PgBoss({ connectionString: url, schema: "pgboss", ...BOSS_OPTIONS });
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
 * A send that cannot happen at all **throws**, and keeps throwing for direct
 * callers: it used to log and return `null`, which is indistinguishable from a
 * dedupe, so a caller had no way to tell "already queued" from "silently lost".
 * What each caller then does with the throw is its own decision — the Stripe
 * route lets it become a 500 so Stripe redelivers, the approvals action logs it
 * and leaves the decision standing for the resume sweep, and the `domain.event`
 * branch below logs it rather than failing a write that already committed.
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
 * Sends a job onto a queue core's topology table does not name **yet**.
 *
 * There is exactly one caller, and it is temporary:
 * `(admin)/projects/delivery-queue.ts`. The handover send has to happen in the
 * worker — it renders a PDF, and Chromium is a dependency of `apps/worker`,
 * deliberately not of this app — but P5-core landed the services without the
 * queue that carries them, and naming that queue in `packages/core` is
 * P5-worker's job, not this app's. Rather than either launch a browser from a
 * Server Action or cast a string to `QueueName`, the send declares the name
 * and the policy it needs and creates the queue itself.
 *
 * `create_queue` is `ON CONFLICT DO NOTHING`, and `ensureQueues` follows every
 * create with an update, so the moment core names this queue its policy wins
 * and this function's argument stops mattering. **When it does, delete this
 * and go back through `sendJob`** — one topology table is the point, and a
 * second place that knows a queue name is how the first one gets forgotten.
 */
export async function sendUnlistedJob(
  name: string,
  policy: QueuePolicy,
  data: object,
  opts?: PgBoss.SendOptions,
): Promise<string | null> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL is not set; cannot queue "${name}"`);
  const boss = await getBoss(url);
  // Idempotent, and cheap enough for a button press: pg-boss refuses a send to
  // a queue that does not exist, and this one is not in `ensureQueues` yet.
  await boss.createQueue(name, { name, policy, ...JOB_RETRY });
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
        // Deliberately still throws. Nothing has committed yet — the inbound
        // webhook route writes no rows of its own — and the route turns the
        // throw into a 500 so the provider redelivers the mail, which is the
        // only thing that can recover it. Swallowing it here would drop a
        // client's email silently.
        await sendJob(
          QUEUE.inboundMessage,
          { organisationId: event.organisationId, inbound: event.inbound },
          { singletonKey: `inbound:${event.inbound.messageId}` },
        );
        return;
      case "message.queued":
        // Logged, not thrown, for the same reason as `default:` — `emit` runs
        // after `replyToConversation` committed the `queued` row, and throwing
        // would turn a saved reply into "Something went wrong" and invite a
        // retry that writes a *second* reply onto the thread. What is lost here
        // is only the delivery, and unlike a dropped fan-out it is re-driven
        // automatically: `outbound.sweep` (cron, every minute) re-enqueues
        // `outbound.message` for any message still `queued` after 60 seconds.
        await sendJob(
          QUEUE.outboundMessage,
          { organisationId: event.organisationId, messageId: event.messageId },
          { singletonKey: `outbound:${event.messageId}` },
        ).catch((err: unknown) => reportDroppedEvent(event, err, OUTBOUND_RECOVERY));
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
        // is deliberately left on the `standard` policy for that reason.
        //
        // A failure here is logged, not thrown. `emit` runs *after* the core
        // service committed, so throwing would turn a write that succeeded into
        // "Something went wrong" and invite a retry that hits a unique
        // violation or creates a second row. The follow-on work is what is
        // lost, and every consumer on this queue has a manual path back
        // (onboarding tasks can be regenerated from the client screen), so the
        // honest outcome is: the write stands, the fan-out is recorded as
        // missing, and a human can re-run it.
        await sendJob(QUEUE.domainEvent, event).catch((err: unknown) => reportDroppedEvent(event, err));
        return;
    }
  });
}

/** What the owner is told to do about a dropped event, when nothing re-drives it. */
const MANUAL_RECOVERY =
  "Anything that event would have triggered (onboarding tasks, for example) has to be re-run by hand.";

/** `outbound.sweep` re-drives this one, so the owner is told to wait, not to act. */
const OUTBOUND_RECOVERY =
  "The reply is saved and still queued; the outbound sweep re-drives it within a minute. Nothing to do unless it is still queued in an hour.";

/**
 * A domain event that could not be queued. Logged, and — best effort — put in
 * front of the owner, because the only other trace is a server log nobody
 * reads. Never throws: the caller's write is already committed, and this is a
 * report about follow-on work, not a failure of the write.
 */
async function reportDroppedEvent(event: DomainEvent, err: unknown, recovery = MANUAL_RECOVERY): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error("domain event could not be queued; the write stands but its follow-on work did not run", {
    event: event.name,
    organisationId: event.organisationId,
    err: message,
  });
  try {
    await notifyOwner(getDb(), event.organisationId, {
      kind: "queue.event_dropped",
      title: `A "${event.name}" follow-up did not start`,
      body: `The record was saved, but queueing its follow-on work failed: ${message}. ${recovery}`,
    });
  } catch (notifyErr) {
    console.error("could not tell the owner about the dropped domain event", {
      event: event.name,
      err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    });
  }
}
