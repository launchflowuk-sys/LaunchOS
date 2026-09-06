import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { notifyOwner } from "../notifications/notify.js";
import { getProposalDetail } from "./crud.js";
import { declinedBody, queueProposalNotice } from "./notices.js";
import {
  PROPOSAL_LIVE_STATUSES,
  PROPOSAL_TARGET_TYPE,
  ProposalRefused,
  normaliseProposalToken,
  proposalRecipient,
  type ProposalRow,
} from "./shared.js";

/**
 * What a client with no account can do, and the rule that governs all of it.
 *
 * **Every function here takes the public token, never an id.** A route on the
 * open internet holds exactly one thing the client legitimately gave it — the
 * token out of the URL — and an id-shaped parameter is an invitation to pass
 * one that was guessed, enumerated or copied from somewhere else. The
 * organisation is still the first argument, as every service in `core` takes
 * it, and both go into the same `where`: a token from another tenant matches
 * nothing rather than something.
 */

export const PROPOSAL_VIEWED_NOTIFICATION_KIND = "proposal.viewed";
export const PROPOSAL_DECLINED_NOTIFICATION_KIND = "proposal.declined";

/** `proposals.metadata` — why they said no, when they said why. */
export const DECLINE_REASON = "declineReason";

export const RecordProposalViewInput = z.object({
  token: z.string().min(1),
  now: z.date().optional(),
});
export type RecordProposalViewInput = z.input<typeof RecordProposalViewInput>;

export interface ProposalViewResult {
  proposal: ProposalRow;
  /** True only for the open that actually stamped `first_viewed_at`. */
  firstView: boolean;
}

/**
 * Records that the client has opened their proposal.
 *
 * Idempotent by construction, not by a read-then-write: the single UPDATE
 * carries `first_viewed_at is null` in its own `where`, so of two page loads
 * arriving together exactly one comes back with a row and the other comes back
 * with nothing. Only the one that stamped the column rings the owner's bell —
 * otherwise a client who reads a proposal three times on the train has rung it
 * three times.
 *
 * A client who opens a proposal after accepting it, or one already expired,
 * changes nothing: the status move is `sent → viewed` and no other.
 */
export async function recordProposalView(
  db: Db,
  organisationId: string,
  input: RecordProposalViewInput,
): Promise<ProposalViewResult | null> {
  const v = RecordProposalViewInput.parse(input);
  const token = normaliseProposalToken(v.token);
  if (!token) return null;
  const now = v.now ?? new Date();

  const [stamped] = await db.update(schema.proposals)
    .set({
      firstViewedAt: now,
      status: sql`case when ${schema.proposals.status} = 'sent' then 'viewed'::proposal_status else ${schema.proposals.status} end`,
      updatedAt: now,
    })
    .where(and(
      eq(schema.proposals.publicToken, token),
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
      isNull(schema.proposals.firstViewedAt),
    ))
    .returning();

  if (!stamped) {
    const [existing] = await db.select().from(schema.proposals)
      .where(and(
        eq(schema.proposals.publicToken, token),
        eq(schema.proposals.organisationId, organisationId),
        isNull(schema.proposals.deletedAt),
      ));
    return existing ? { proposal: existing, firstView: false } : null;
  }

  await recordAudit(db, organisationId, {
    actorKind: "client", action: "proposal.viewed",
    targetType: PROPOSAL_TARGET_TYPE, targetId: stamped.id, after: stamped,
  });
  await recordActivity(db, organisationId, {
    ...(stamped.clientId ? { clientId: stamped.clientId } : {}),
    actorKind: "client", kind: "proposal.viewed",
    title: `Proposal ${stamped.reference} was opened`,
    link: `/proposals/${stamped.id}`,
  });
  await notifyOwner(db, organisationId, {
    kind: PROPOSAL_VIEWED_NOTIFICATION_KIND,
    title: `Proposal ${stamped.reference} opened: ${stamped.title}`,
    link: `/proposals/${stamped.id}`,
  });
  return { proposal: stamped, firstView: true };
}

export const DeclineProposalInput = z.object({
  token: z.string().min(1),
  reason: z.string().trim().max(2000).optional(),
  now: z.date().optional(),
});
export type DeclineProposalInput = z.input<typeof DeclineProposalInput>;

export interface DeclineProposalResult {
  proposal: ProposalRow;
  /** False when this call is the second tap on the same button. */
  recorded: boolean;
}

/**
 * Records a no.
 *
 * Idempotent the same way acceptance is, and for the same reason: the client
 * is on a phone. A second decline returns the first one untouched rather than
 * queueing a second apology, and a proposal already accepted is refused
 * outright — a decision that has been made cannot be unmade from a public page.
 */
export async function declineProposal(
  db: Db,
  organisationId: string,
  input: DeclineProposalInput,
): Promise<DeclineProposalResult> {
  const v = DeclineProposalInput.parse(input);
  const token = normaliseProposalToken(v.token);
  if (!token) throw new ProposalRefused("not_found", "That proposal could not be found.");
  const now = v.now ?? new Date();

  const [before] = await db.select().from(schema.proposals)
    .where(and(
      eq(schema.proposals.publicToken, token),
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
    ));
  if (!before) throw new ProposalRefused("not_found", "That proposal could not be found.");
  if (before.status === "declined") return { proposal: before, recorded: false };
  if (!PROPOSAL_LIVE_STATUSES.includes(before.status)) {
    throw new ProposalRefused("not_live", `Proposal ${before.reference} is no longer open for a decision.`);
  }

  const recipient = await proposalRecipient(db, organisationId, before);
  const declined = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const stamp = { ...(v.reason ? { [DECLINE_REASON]: v.reason } : {}), declinedAt: now.toISOString() };
    const [after] = await tx.update(schema.proposals)
      .set({
        status: "declined",
        decidedAt: now,
        metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.proposals.id, before.id),
        eq(schema.proposals.organisationId, organisationId),
        // The status is in the key, so two taps cannot both win the update.
        eq(schema.proposals.status, before.status),
      ))
      .returning();
    if (!after) return null;
    await recordAudit(tx, organisationId, {
      actorKind: "client", action: "proposal.declined",
      targetType: PROPOSAL_TARGET_TYPE, targetId: before.id, before, after,
    });
    await recordActivity(tx, organisationId, {
      ...(after.clientId ? { clientId: after.clientId } : {}),
      actorKind: "client", kind: "proposal.declined",
      title: `Proposal ${after.reference} was declined`,
      ...(v.reason ? { body: v.reason } : {}),
      link: `/proposals/${after.id}`,
    });
    const notice = recipient
      ? await queueProposalNotice(tx, organisationId, {
          proposal: after, notice: "declined", to: recipient.email,
          subject: `Thanks for letting us know — ${after.reference}`,
          body: declinedBody(after, recipient.name),
          actorKind: "client",
        })
      : null;
    return { after, notice };
  });

  if (!declined) {
    const detail = await getProposalDetail(db, organisationId, before.id);
    return { proposal: detail?.proposal ?? before, recorded: false };
  }

  await notifyOwner(db, organisationId, {
    kind: PROPOSAL_DECLINED_NOTIFICATION_KIND,
    title: `Proposal ${declined.after.reference} was declined`,
    ...(v.reason ? { body: v.reason } : {}),
    link: `/proposals/${declined.after.id}`,
  });
  if (declined.notice) await emit({ name: "message.queued", organisationId, messageId: declined.notice.id });
  return { proposal: declined.after, recorded: true };
}
