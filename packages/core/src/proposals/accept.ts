import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { convertLeadToClient } from "../leads/leads.js";
import { notifyOwner } from "../notifications/notify.js";
import { getProposalDetail } from "./crud.js";
import { FOLLOW_ON_QUEUED_AT, queueProposalFollowOn, type ProposalAcceptedJobData } from "./follow-on.js";
import { acceptedBody, queueProposalNotice } from "./notices.js";
import { isPricedAtNothing } from "./pricing.js";
import {
  PROPOSAL_LIVE_STATUSES,
  PROPOSAL_SUBJECT_TYPE,
  PROPOSAL_TARGET_TYPE,
  ProposalRefused,
  SignaturePathSchema,
  getProposalAcceptance,
  hasExpired,
  isUniqueViolation,
  normaliseProposalToken,
  proposalActorUserId,
  type ProposalAcceptanceRow,
  type ProposalRow,
} from "./shared.js";

/**
 * A client agreeing, which is the one write in this domain the business would
 * miss if it went wrong.
 *
 * Three properties, in order of how much they matter:
 *
 * 1. **It happens once.** The unique index on `proposal_acceptances.proposal_id`
 *    is what decides that, not a read-then-insert — a client on a phone taps
 *    Accept twice inside 40 ms, and both requests pass a read check. The second
 *    insert loses to the index and this function returns the *first* acceptance
 *    with `alreadyAccepted: true`: one record, one email, one owner alert.
 * 2. **It is one transaction.** The acceptance record, the status, the lead's
 *    conversion into a client and the client's confirmation email all commit
 *    together or not at all. There is no state where somebody is a client of a
 *    proposal that is still `sent`.
 * 3. **It does not do the slow half inline.** Countersigning needs Chromium,
 *    the payment step needs Stripe and the project needs P4 — none of which
 *    belongs inside a transaction a client is waiting on. Those go to
 *    `queueProposalFollowOn`, and `metadata.followOnQueuedAt` records that they
 *    did, so a queue that was down is findable rather than forgotten.
 */

export const PROPOSAL_ACCEPTED_NOTIFICATION_KIND = "proposal.accepted";

export const AcceptProposalInput = z.object({
  /** The public token out of the URL — never an id. */
  token: z.string().min(1),
  acceptedName: z.string().trim().min(1, "please type your name").max(160),
  acceptedEmail: z.string().trim().email("that does not look like an email address").max(320),
  /** SVG path data from the signature canvas, normalised to `SIGNATURE_VIEWBOX`. */
  signatureSvg: SignaturePathSchema.optional(),
  ip: z.string().trim().max(64).optional(),
  userAgent: z.string().trim().max(500).optional(),
  now: z.date().optional(),
});
export type AcceptProposalInput = z.input<typeof AcceptProposalInput>;

export interface AcceptProposalResult {
  proposal: ProposalRow;
  acceptance: ProposalAcceptanceRow;
  /** The client they now are — converted from the lead, or the one they already were. */
  clientId: string | null;
  /** True when this call found an acceptance already there and wrote nothing. */
  alreadyAccepted: boolean;
}

/**
 * Records a client's acceptance.
 *
 * The proposal is found by token *and* organisation, so a token minted for one
 * tenant matches nothing in another; everything after that reads from the row
 * rather than from the caller.
 */
export async function acceptProposal(
  db: Db,
  organisationId: string,
  input: AcceptProposalInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptProposalResult> {
  const v = AcceptProposalInput.parse(input);
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

  // The cheap half of idempotency: a page reloaded an hour later never gets
  // as far as the index.
  if (before.status === "accepted") return alreadyAccepted(db, organisationId, before);

  if (!PROPOSAL_LIVE_STATUSES.includes(before.status)) {
    throw new ProposalRefused("not_live", `Proposal ${before.reference} is no longer open for a decision.`);
  }
  if (hasExpired(before, now)) {
    throw new ProposalRefused("expired", `Proposal ${before.reference} expired — ask us for a fresh one and we'll send it straight over.`);
  }
  const detail = (await getProposalDetail(db, organisationId, before.id))!;
  if (isPricedAtNothing(detail.totals)) {
    throw new ProposalRefused("no_price", `Proposal ${before.reference} has no price on it to agree to.`);
  }

  const actorUserId = await proposalActorUserId(db, organisationId, before);

  let committed;
  try {
    committed = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;

      const [acceptance] = await tx.insert(schema.proposalAcceptances).values({
        organisationId,
        proposalId: before.id,
        acceptedName: v.acceptedName,
        acceptedEmail: v.acceptedEmail.toLowerCase(),
        acceptedAt: now,
        ip: v.ip ?? null,
        userAgent: v.userAgent ?? null,
        signatureSvg: v.signatureSvg ?? null,
      }).returning();

      // The lead becomes a client here, through the one conversion that
      // already exists: it creates the billing profile, emits `client.created`
      // so the onboarding tasks generate, and moves the lead's thread and
      // meetings across. Writing a second conversion would mean two of those
      // to keep in step. A lead already converted — they had another proposal
      // accepted last month — is reused rather than converted twice.
      const clientId = await ensureClient(tx, organisationId, before, actorUserId);

      const [after] = await tx.update(schema.proposals)
        .set({
          status: "accepted",
          decidedAt: now,
          ...(clientId && !before.clientId ? { clientId } : {}),
          updatedAt: now,
        })
        .where(and(
          eq(schema.proposals.id, before.id),
          eq(schema.proposals.organisationId, organisationId),
          // The status is part of the key, so a second tap that somehow got
          // past the index still cannot write over the first decision.
          eq(schema.proposals.status, before.status),
        ))
        .returning();
      if (!after) throw new ProposalRefused("not_live", "That proposal was decided a moment ago.");

      // The PDF the client was sent was filed against a lead and so has no
      // `client_id`. Now that they are a client, it needs one, or their own
      // proposal is unreadable from their portal.
      if (clientId) {
        await tx.update(schema.documents)
          .set({ clientId, updatedAt: now })
          .where(and(
            eq(schema.documents.organisationId, organisationId),
            eq(schema.documents.subjectType, PROPOSAL_SUBJECT_TYPE),
            eq(schema.documents.subjectId, before.id),
            isNull(schema.documents.clientId),
          ));
      }

      await recordAudit(tx, organisationId, {
        actorKind: "client", action: "proposal.accepted",
        targetType: PROPOSAL_TARGET_TYPE, targetId: before.id, before, after,
      });
      await recordAudit(tx, organisationId, {
        actorKind: "client", action: "proposal.acceptance_recorded",
        targetType: "proposal_acceptance", targetId: acceptance!.id, after: acceptance,
      });
      await recordActivity(tx, organisationId, {
        ...(clientId ? { clientId } : {}),
        actorKind: "client", kind: "proposal.accepted",
        title: `Proposal ${after.reference} accepted by ${v.acceptedName}`,
        link: `/proposals/${after.id}`,
      });

      const notice = await queueProposalNotice(tx, organisationId, {
        proposal: after,
        notice: "accepted",
        to: v.acceptedEmail,
        subject: `Accepted: ${after.title} (${after.reference})`,
        body: acceptedBody(after, detail.totals, v.acceptedName, env),
        actorKind: "client",
      });

      return { proposal: after, acceptance: acceptance!, clientId, notice };
    });
  } catch (error) {
    // The index had the final word: somebody else's request wrote the
    // acceptance while this one was in flight. Their record stands.
    if (isUniqueViolation(error)) return alreadyAccepted(db, organisationId, before);
    throw error;
  }

  await notifyOwner(db, organisationId, {
    kind: PROPOSAL_ACCEPTED_NOTIFICATION_KIND,
    title: `Proposal ${committed.proposal.reference} accepted by ${v.acceptedName}`,
    body: committed.proposal.title,
    link: `/proposals/${committed.proposal.id}`,
  });
  await emit({ name: "message.queued", organisationId, messageId: committed.notice.id });
  await handOn(db, organisationId, committed.proposal, committed.acceptance, committed.clientId, detail.totals.dueOnAcceptancePence, detail.totals.recurringMonthlyPence);

  return {
    proposal: committed.proposal,
    acceptance: committed.acceptance,
    clientId: committed.clientId,
    alreadyAccepted: false,
  };
}

/** The acceptance that is already there, for a second tap or a reloaded page. */
async function alreadyAccepted(db: Db, organisationId: string, proposal: ProposalRow): Promise<AcceptProposalResult> {
  const [current] = await db.select().from(schema.proposals)
    .where(and(eq(schema.proposals.id, proposal.id), eq(schema.proposals.organisationId, organisationId)));
  const acceptance = await getProposalAcceptance(db, organisationId, proposal.id);
  if (!acceptance) throw new ProposalRefused("not_live", `Proposal ${proposal.reference} is no longer open for a decision.`);
  return { proposal: current ?? proposal, acceptance, clientId: (current ?? proposal).clientId, alreadyAccepted: true };
}

/**
 * The client this proposal belongs to once it is accepted.
 *
 * Already a client, or a lead already converted by an earlier proposal, or the
 * conversion itself. Null only when the proposal is on a lead and there is
 * nobody to credit the conversion to — a brand-new organisation with no owner
 * yet — in which case the acceptance is still recorded and the lead is left
 * for a person. Losing an acceptance is far worse than a lead converted late.
 */
async function ensureClient(db: Db, organisationId: string, proposal: ProposalRow, actorUserId: string | null): Promise<string | null> {
  if (proposal.clientId) return proposal.clientId;
  if (!proposal.leadId) return null;
  const [lead] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, proposal.leadId), eq(schema.leads.organisationId, organisationId)));
  if (!lead) return null;
  if (lead.clientId) return lead.clientId;
  if (!actorUserId) {
    console.error({ organisationId, proposalId: proposal.id }, "proposal accepted but no owner to credit the lead conversion to; the lead is unconverted");
    return null;
  }
  const { client } = await convertLeadToClient(db, organisationId, {
    leadId: lead.id,
    actorId: actorUserId,
    ...(proposal.packageId ? { packageId: proposal.packageId } : {}),
  });
  return client.id;
}

/**
 * Hands the countersigning, the payment step and the project to the worker.
 *
 * A failure here is logged, not thrown: the client has agreed, that is
 * committed, and taking their Accept button down because a queue is having a
 * bad minute would be the wrong trade. `followOnQueuedAt` is only stamped once
 * the send returned, so `proposalsAwaitingFollowOn` picks up whatever did not.
 */
async function handOn(
  db: Db,
  organisationId: string,
  proposal: ProposalRow,
  acceptance: ProposalAcceptanceRow,
  clientId: string | null,
  dueOnAcceptancePence: number,
  recurringMonthlyPence: number,
): Promise<void> {
  const job: ProposalAcceptedJobData = {
    organisationId,
    proposalId: proposal.id,
    acceptanceId: acceptance.id,
    clientId,
    shape: proposal.pricing.shape,
    dueOnAcceptancePence,
    recurringMonthlyPence,
    packageId: proposal.packageId,
  };
  try {
    await queueProposalFollowOn(job);
    await db.update(schema.proposals)
      .set({
        metadata: sql`coalesce(${schema.proposals.metadata}, '{}'::jsonb) || ${JSON.stringify({ [FOLLOW_ON_QUEUED_AT]: new Date().toISOString() })}::jsonb`,
      })
      .where(and(eq(schema.proposals.id, proposal.id), eq(schema.proposals.organisationId, organisationId)));
  } catch (error) {
    console.error(
      { organisationId, proposalId: proposal.id, error: error instanceof Error ? error.message : String(error) },
      "proposal follow-on could not be queued; the acceptance is recorded and the sweep will pick it up",
    );
  }
}
