import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";

/**
 * Whether the mail is actually moving.
 *
 * The Email screen listed which address belongs to which client and stopped
 * there, so the two questions worth asking of a mail system — is anything
 * failing, and is anything stuck — had no answer anywhere in the product. A
 * reply to a client that never left is invisible until the client chases.
 *
 * Read-only, so no audit row. Counts are scoped to the organisation in every
 * clause, like everything else.
 */
export interface EmailHealth {
  /** Inbound in the window. */
  readonly received: number;
  /** Outbound that made it in the window. */
  readonly sent: number;
  /** Outbound the adapter rejected, all time — a failure does not stop mattering after a week. */
  readonly failed: number;
  /**
   * Queued and older than `stuckAfterMinutes`. Something the worker should have
   * picked up and did not, which usually means the worker is down.
   */
  readonly stuck: number;
  /** Clients with a support address, and how many there are in total. */
  readonly routed: number;
  readonly clients: number;
}

/** Long enough that a healthy queue is never called stuck; short enough to catch a dead worker the same morning. */
const STUCK_AFTER_MINUTES = 15;

export async function emailHealth(
  db: Db,
  organisationId: string,
  since: Date,
  now: Date = new Date(),
): Promise<EmailHealth> {
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000);
  const mine = eq(schema.messages.organisationId, organisationId);
  const isEmail = eq(schema.messages.channel, "email");

  const [received, sent, failed, stuck, routed, clients] = await Promise.all([
    db.select({ value: count() }).from(schema.messages)
      .where(and(mine, isEmail, eq(schema.messages.status, "received"), gte(schema.messages.createdAt, since))),
    db.select({ value: count() }).from(schema.messages)
      .where(and(mine, isEmail, eq(schema.messages.status, "sent"), gte(schema.messages.createdAt, since))),
    db.select({ value: count() }).from(schema.messages)
      .where(and(mine, isEmail, eq(schema.messages.status, "failed"))),
    db.select({ value: count() }).from(schema.messages)
      .where(and(mine, isEmail, eq(schema.messages.status, "queued"), lt(schema.messages.createdAt, stuckBefore))),
    db.select({ value: sql<number>`count(distinct ${schema.emailIdentities.clientId})::int` })
      .from(schema.emailIdentities)
      .where(eq(schema.emailIdentities.organisationId, organisationId)),
    db.select({ value: count() }).from(schema.clients)
      .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.status, "active"))),
  ]);

  return {
    received: received[0]?.value ?? 0,
    sent: sent[0]?.value ?? 0,
    failed: failed[0]?.value ?? 0,
    stuck: stuck[0]?.value ?? 0,
    routed: Number(routed[0]?.value ?? 0),
    clients: clients[0]?.value ?? 0,
  };
}
