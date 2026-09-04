import { CLAIM_TTL_MINUTES, MAX_ADDRESS_CHARS, notifyOwner, truncate } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import { QUEUE } from "../boss.js";
import type { BossSender } from "./dispatch-event.js";
import { sweep, throwOnSweepFailure, type SweepLogger, type SweepSummary } from "./sweep.js";

/**
 * How long a `queued` message is given before this sweep re-enqueues its
 * `outbound.message` job. A minute: the normal path enqueues the job in the same
 * request that wrote the row, so anything still queued after that either lost
 * its enqueue or lost its job.
 */
export const OUTBOUND_UNDELIVERED_AFTER_MS = 60_000;

/**
 * The far edge of the window, for the same reason `RESUME_GIVE_UP_AFTER_MS`
 * has one: a message still `queued` a day later is not an unlucky delivery.
 * `sendQueuedMessage` gives up after `MAX_SEND_ATTEMPTS` by writing `failed`,
 * so anything that reaches this bound is stuck on something re-sending cannot
 * fix, and re-enqueueing it every minute for ever would bury real failures.
 */
export const OUTBOUND_GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/** Stamped on a message once its give-up has been announced, so it is announced once. */
const GIVE_UP_NOTIFIED = "outboundGiveUpNotifiedAt";

const LABEL = "outbound message sweep";
const GIVE_UP_LABEL = "outbound message give-up";

export interface OutboundSweepDeps {
  readonly db: Db;
  readonly boss: BossSender;
  readonly logger?: SweepLogger & { info(...args: unknown[]): void };
}

export interface UndeliveredMessage {
  readonly id: string;
}

/**
 * Outbound messages whose `outbound.message` job never arrived.
 *
 * `replyToConversation` writes the row and then `emit`s `message.queued`; the
 * web's forwarder turns that into a job. A pg-boss that is briefly unreachable
 * at that instant leaves a committed `queued` row with nothing to drive it — and
 * before this sweep existed, nothing ever revisited it: the reply sat on the
 * thread, visible to staff and in the client's history, and was never sent.
 *
 * A message another worker is actively holding is skipped: `sendQueuedMessage`
 * takes a `CLAIM_TTL_MINUTES` lease, and while that lease is live a re-enqueued
 * job would only claim nothing and return. Matching the lease here means the
 * sweep never enqueues against a send that is still in flight — which also
 * removes the four wasted jobs a slow send used to collect. A message the send
 * has given up on is `failed`, not `queued`, so it drops out of here on its own.
 */
export async function findUndeliveredMessages(
  db: Db,
  organisationId: string,
  now: Date,
): Promise<UndeliveredMessage[]> {
  const cutoff = new Date(now.getTime() - OUTBOUND_UNDELIVERED_AFTER_MS);
  const floor = new Date(now.getTime() - OUTBOUND_GIVE_UP_AFTER_MS);
  const rows = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.organisationId, organisationId),
        eq(schema.messages.direction, "outbound"),
        eq(schema.messages.status, "queued"),
        isNull(schema.messages.deletedAt),
        lt(schema.messages.createdAt, cutoff),
        gt(schema.messages.createdAt, floor),
        unclaimed(),
      ),
    );
  return rows.map((row) => ({ id: row.id }));
}

/** The same predicate `sendQueuedMessage`'s claim uses: free, or the lease has expired. */
function unclaimed() {
  return sql`(
    ${schema.messages.metadata}->>'claimedAt' IS NULL
    OR (${schema.messages.metadata}->>'claimedAt')::timestamptz < now() - (${CLAIM_TTL_MINUTES} * interval '1 minute')
  )`;
}

/**
 * Messages that have crossed the far edge of the window still undelivered.
 *
 * The give-up bound is the one moment a permanently undeliverable reply is
 * knowable, and until now it was also the moment the system went quiet about it:
 * the row simply stopped matching `findUndeliveredMessages` and nothing was
 * written or said. One notification per message closes that, keyed on a metadata
 * marker so a sweep running every minute for the rest of the message's life
 * announces it exactly once.
 *
 * `unclaimed()` is here for the same reason it is on the re-enqueue query, and
 * it is the difference between an alert and a false alarm: a message claimed
 * seconds before it crossed the bound is *being sent right now*, and announcing
 * "queued for a day and never sent" about a send still in flight would be a
 * notification that contradicts the thread by the time anyone reads it. The
 * marker is stamped alongside the alert, so without this predicate that false
 * alarm would also be the row's one and only announcement. A claim outlives the
 * lease by at most `CLAIM_TTL_MINUTES`, so a genuinely stuck message is
 * announced a few minutes later instead of never.
 */
export async function findGivenUpMessages(db: Db, organisationId: string, now: Date): Promise<UndeliveredMessage[]> {
  const floor = new Date(now.getTime() - OUTBOUND_GIVE_UP_AFTER_MS);
  const rows = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.organisationId, organisationId),
        eq(schema.messages.direction, "outbound"),
        eq(schema.messages.status, "queued"),
        isNull(schema.messages.deletedAt),
        lte(schema.messages.createdAt, floor),
        unclaimed(),
        sql`${schema.messages.metadata} ->> ${GIVE_UP_NOTIFIED} is null`,
      ),
    );
  return rows.map((row) => ({ id: row.id }));
}

/** `sendQueuedMessage` counts its tries in `metadata.attempts`; absent means it never ran. */
function attemptsOf(metadata: Record<string, unknown> | undefined): number {
  const raw = metadata?.["attempts"];
  return typeof raw === "number" ? raw : 0;
}

/**
 * What is actually known about a message at the give-up bound, and nothing else.
 *
 * This body used to say "the outbound sweep has re-enqueued it every minute for
 * 24 hours without it leaving". After a worker outage longer than the bound that
 * is simply false — the give-up query has no lower bound, so the whole backlog
 * crosses it in the first tick after the worker comes back, having been
 * re-enqueued not once — and an alert that misdescribes what was tried sends
 * whoever reads it looking for an SMTP fault that never happened.
 *
 * So: when it was queued, how long ago that was, and how many send attempts the
 * row itself records. `attempts: 0` is the useful signal the old sentence hid —
 * it means no job ever ran, which points at the queue rather than at the relay.
 */
function givenUpBody(queuedAt: Date | undefined, attempts: number, now: Date): string {
  const tried =
    attempts === 0 ? "no recorded send attempts" : `${attempts} recorded send attempt${attempts === 1 ? "" : "s"}`;
  const queued = queuedAt
    ? `Queued at ${queuedAt.toISOString()}, ${Math.floor((now.getTime() - queuedAt.getTime()) / 3_600_000)} hours ago`
    : "Queued past the give-up bound";
  return (
    `${queued}, with ${tried}, and still not sent. ` +
    "The sweep will not re-enqueue it again — open the thread and send it by hand once the cause is fixed."
  );
}

/**
 * Tells the owner about every message this sweep has stopped re-enqueueing, once.
 *
 * The marker is stamped *after* the notification, on purpose and for the same
 * reason as `sendQueuedMessage`'s: a crash between the two costs a duplicate
 * alert, and a duplicate is much cheaper than a reply nobody ever hears about.
 *
 * But it is stamped after a *failed* notification too. `notifyOwner` validates
 * `title` at 200 characters, and the title below interpolates
 * `messages.to_email` — a `text` column whose value on a reply is copied off the
 * inbound sender's `From` header. A structurally over-long one used to throw
 * here every minute for the life of the row: the marker was never reached, so
 * the same row was retried on every cron tick, logged an error every minute and
 * had its give-up announced never. Truncating the address is what stops that
 * happening at all; stamping on failure is what stops any residual permanent
 * failure becoming the same loop. A transient failure therefore costs the alert
 * — which is why the whole alert is logged with the error, so it survives in the
 * worker's log rather than nowhere.
 */
export async function notifyGivenUpMessages(
  deps: Omit<OutboundSweepDeps, "boss">,
  organisationId: string,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
  const givenUp = await findGivenUpMessages(deps.db, organisationId, now);
  const summary = await sweep(
    givenUp,
    { label: GIVE_UP_LABEL, id: (row) => row.id, logger },
    async (row) => {
      const [message] = await deps.db
        .select({
          toEmail: schema.messages.toEmail,
          conversationId: schema.messages.conversationId,
          createdAt: schema.messages.createdAt,
          metadata: schema.messages.metadata,
        })
        .from(schema.messages)
        .where(and(eq(schema.messages.id, row.id), eq(schema.messages.organisationId, organisationId)));
      const to = truncate(message?.toEmail ?? "the client", MAX_ADDRESS_CHARS);
      const alert = {
        kind: "message.undelivered",
        title: `A reply to ${to} has been queued for a day and never sent`,
        body: givenUpBody(message?.createdAt, attemptsOf(message?.metadata), now),
        ...(message ? { link: `/inbox/${message.conversationId}` } : {}),
      };
      try {
        await notifyOwner(deps.db, organisationId, alert);
      } catch (err: unknown) {
        logger.error(
          { organisationId, messageId: row.id, alert, err: String(err) },
          `${GIVE_UP_LABEL} notification failed; marking it announced so it is not retried every minute`,
        );
      }
      // Outside the try on purpose: if *this* write fails the item fails, the
      // sweep reports it, and the next tick tries the whole thing again — which
      // is right, because nothing has been recorded yet.
      await deps.db
        .update(schema.messages)
        .set({
          metadata: sql`coalesce(${schema.messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ [GIVE_UP_NOTIFIED]: now.toISOString() })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.messages.id, row.id), eq(schema.messages.organisationId, organisationId)));
    },
  );
  if (summary.processed > 0 || summary.failed > 0) {
    logger.info({ organisationId, gaveUp: summary.processed, failed: summary.failed }, GIVE_UP_LABEL);
  }
  throwOnSweepFailure(GIVE_UP_LABEL, summary);
  return summary;
}

/**
 * Re-enqueues every undelivered outbound message for one organisation, under the
 * same `outbound:<messageId>` key the web request and `dispatchEvent` use, so a
 * job already queued is deduped rather than duplicated. Isolated per message:
 * one failed send must not cost the rest of the sweep its turn.
 *
 * Also announces the give-up edge (`notifyGivenUpMessages`) on the way past,
 * because the two questions share a window and a cron tick.
 */
export async function runOutboundSweep(
  deps: OutboundSweepDeps,
  organisationId: string,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
  // The give-up edge first: a message that crossed it is about to stop matching
  // the re-enqueue query below, and this is the last chance to say so. Its
  // failures are logged rather than thrown — an alert that cannot be written
  // must not cost the messages that can still be delivered their re-enqueue.
  await notifyGivenUpMessages(deps, organisationId, now).catch((err: unknown) => {
    logger.error({ organisationId, err: String(err) }, "outbound give-up notification failed");
  });
  const pending = await findUndeliveredMessages(deps.db, organisationId, now);
  const summary = await sweep(
    pending,
    { label: LABEL, id: (row) => row.id, logger },
    async (row) => {
      logger.info({ messageId: row.id, organisationId }, "re-enqueueing an undelivered outbound.message");
      return deps.boss.send(
        QUEUE.outboundMessage,
        { organisationId, messageId: row.id },
        { singletonKey: `outbound:${row.id}` },
      );
    },
  );
  if (summary.processed > 0 || summary.failed > 0) {
    logger.info({ organisationId, requeued: summary.processed, failed: summary.failed }, LABEL);
  }
  throwOnSweepFailure(LABEL, summary);
  return summary;
}
