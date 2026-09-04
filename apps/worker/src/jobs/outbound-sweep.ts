import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
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

const LABEL = "outbound message sweep";

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
 * Deliberately not filtered on a claim: `sendQueuedMessage` claims in one
 * conditional UPDATE and returns the row untouched when it cannot, so a
 * duplicate delivery is already a no-op. A message it has given up on is
 * `failed`, not `queued`, so it drops out of here on its own.
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
      ),
    );
  return rows.map((row) => ({ id: row.id }));
}

/**
 * Re-enqueues every undelivered outbound message for one organisation, under the
 * same `outbound:<messageId>` key the web request and `dispatchEvent` use, so a
 * job already queued is deduped rather than duplicated. Isolated per message:
 * one failed send must not cost the rest of the sweep its turn.
 */
export async function runOutboundSweep(
  deps: OutboundSweepDeps,
  organisationId: string,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const logger = deps.logger ?? console;
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
