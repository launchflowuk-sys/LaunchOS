import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { FOLLOW_ON_QUEUED_AT } from "./follow-on.js";
import { PROPOSAL_LIVE_STATUSES, PROPOSAL_TARGET_TYPE, proposalExpiresAt, type ProposalRow } from "./shared.js";

/**
 * The daily passes the worker makes over proposals.
 *
 * Each one is a query and a decision, and each returns what it did so the job
 * can log it. Nothing here sends a client an email on its own: chasing a
 * prospect is Shoji's call to make, so the nudge rings his bell and stops.
 */

/** `proposals.metadata` — the day the owner was last nudged about this one. */
export const NUDGED_AT = "nudgedAt";
/** After this long unopened, a sent proposal is worth mentioning. */
export const NUDGE_AFTER_DAYS = 3;

export const PROPOSAL_EXPIRED_NOTIFICATION_KIND = "proposal.expired";
export const PROPOSAL_UNOPENED_NOTIFICATION_KIND = "proposal.unopened";

export const ExpireProposalsInput = z.object({ now: z.date().optional(), limit: z.number().int().min(1).max(500).default(200) });
export type ExpireProposalsInput = z.input<typeof ExpireProposalsInput>;

export interface ExpireProposalsResult {
  expired: ProposalRow[];
}

/**
 * Moves live proposals past their validity date to `expired`.
 *
 * The cut-off is computed per row rather than in SQL, because "valid until 30
 * September" means the end of that day in London and the offset is different
 * in summer — `proposalExpiresAt` is the one place that arithmetic is done,
 * and doing it twice in two languages is how the two would eventually differ
 * by an hour. The candidate set is narrowed in SQL to rows dated today or
 * earlier, so the per-row pass is short.
 */
export async function expireProposals(db: Db, organisationId: string, input: ExpireProposalsInput = {}): Promise<ExpireProposalsResult> {
  const v = ExpireProposalsInput.parse(input);
  const now = v.now ?? new Date();
  // Narrowed in SQL to dates no later than today anywhere on earth; the
  // per-row check below decides which of those have actually run out.
  const today = now.toISOString().slice(0, 10);

  const candidates = await db.select().from(schema.proposals)
    .where(and(
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
      inArray(schema.proposals.status, [...PROPOSAL_LIVE_STATUSES]),
      lte(schema.proposals.validUntil, today),
    ))
    .orderBy(asc(schema.proposals.validUntil), asc(schema.proposals.id))
    .limit(v.limit);

  const expired: ProposalRow[] = [];
  for (const before of candidates) {
    const expiresAt = proposalExpiresAt(before.validUntil);
    if (!expiresAt || now.getTime() < expiresAt.getTime()) continue;
    const [after] = await db.update(schema.proposals)
      .set({ status: "expired", updatedAt: now })
      .where(and(
        eq(schema.proposals.id, before.id),
        eq(schema.proposals.organisationId, organisationId),
        eq(schema.proposals.status, before.status),
      ))
      .returning();
    if (!after) continue;
    await recordAudit(db, organisationId, {
      actorKind: "system", action: "proposal.expired",
      targetType: PROPOSAL_TARGET_TYPE, targetId: after.id, before, after,
    });
    await recordActivity(db, organisationId, {
      ...(after.clientId ? { clientId: after.clientId } : {}),
      actorKind: "system", kind: "proposal.expired",
      title: `Proposal ${after.reference} expired without a decision`,
      link: `/proposals/${after.id}`,
    });
    await notifyOwner(db, organisationId, {
      kind: PROPOSAL_EXPIRED_NOTIFICATION_KIND,
      title: `Proposal ${after.reference} expired: ${after.title}`,
      link: `/proposals/${after.id}`,
    });
    expired.push(after);
  }
  return { expired };
}

export const NudgeProposalsInput = z.object({
  now: z.date().optional(),
  days: z.number().int().min(1).max(30).default(NUDGE_AFTER_DAYS),
  limit: z.number().int().min(1).max(200).default(50),
});
export type NudgeProposalsInput = z.input<typeof NudgeProposalsInput>;

export interface NudgeProposalsResult {
  nudged: ProposalRow[];
}

/**
 * Rings the owner's bell about proposals that were sent and never opened.
 *
 * Deliberately not an email to the client. Shoji said chasing is his call, so
 * the sweep's whole job is to make sure he knows — once per proposal, stamped
 * in metadata, so a proposal that sits unopened for a fortnight does not ring
 * fourteen times.
 */
export async function nudgeUnopenedProposals(db: Db, organisationId: string, input: NudgeProposalsInput = {}): Promise<NudgeProposalsResult> {
  const v = NudgeProposalsInput.parse(input);
  const now = v.now ?? new Date();
  const cutoff = new Date(now.getTime() - v.days * 24 * 3_600_000);

  const candidates = await db.select().from(schema.proposals)
    .where(and(
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
      eq(schema.proposals.status, "sent"),
      isNull(schema.proposals.firstViewedAt),
      lt(schema.proposals.sentAt, cutoff),
      sql`${schema.proposals.metadata}->>${NUDGED_AT} is null`,
    ))
    .orderBy(asc(schema.proposals.sentAt), asc(schema.proposals.id))
    .limit(v.limit);

  const nudged: ProposalRow[] = [];
  for (const proposal of candidates) {
    const [after] = await db.update(schema.proposals)
      .set({ metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [NUDGED_AT]: now.toISOString() })}::jsonb` })
      .where(and(
        eq(schema.proposals.id, proposal.id),
        eq(schema.proposals.organisationId, organisationId),
        sql`${schema.proposals.metadata}->>${NUDGED_AT} is null`,
      ))
      .returning();
    if (!after) continue;
    await notifyOwner(db, organisationId, {
      kind: PROPOSAL_UNOPENED_NOTIFICATION_KIND,
      title: `Proposal ${after.reference} still unopened after ${v.days} days`,
      body: after.title,
      link: `/proposals/${after.id}`,
    });
    nudged.push(after);
  }
  return { nudged };
}

/**
 * Accepted proposals whose follow-on never reached the queue.
 *
 * The safety net under `acceptProposal`'s deliberate decision to log rather
 * than throw when the queue is down. Every one of these is a client who has
 * agreed and is waiting for a payment link, so the worker checks this on every
 * pass, not once a day.
 */
export async function proposalsAwaitingFollowOn(db: Db, organisationId: string, limit = 50): Promise<ProposalRow[]> {
  return db.select().from(schema.proposals)
    .where(and(
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
      eq(schema.proposals.status, "accepted"),
      sql`${schema.proposals.metadata}->>${FOLLOW_ON_QUEUED_AT} is null`,
    ))
    .orderBy(asc(schema.proposals.decidedAt), asc(schema.proposals.id))
    .limit(limit);
}
