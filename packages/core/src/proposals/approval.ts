import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { getProposalDetail } from "./crud.js";
import { SHAPE_LABEL, describePricing, isPricedAtNothing } from "./pricing.js";
import { sendProposal, type ProposalDeps } from "./send.js";
import {
  ActorKindSchema,
  PROPOSAL_TARGET_TYPE,
  ProposalRefused,
  hasExpired,
  isUniqueViolation,
  requireProposal,
  type ProposalRow,
} from "./shared.js";

/**
 * The human gate on a proposal leaving the building.
 *
 * Everything else in this domain a person does themselves; this is the one
 * path an agent can start. The Proposal Drafter writes a draft and asks — it
 * never sends — and the owner decides on /approvals with the whole document
 * in front of him.
 *
 * The card is run-less on purpose (no `run_id`), like `lead_reply` and
 * `content_publish`: the drafter's run has finished by the time anybody
 * looks, so there is nothing for the kernel to resume, and the decision is
 * carried out by `applyProposalSendDecision` instead.
 *
 * **Approving it runs in the worker.** Sending renders a PDF, and Chromium
 * lives only in `apps/worker`'s image — so `applyProposalSendDecision` takes
 * the same injected renderer `sendProposal` does, and the web app queues
 * `proposals.send` rather than calling it.
 */

/** `approvals.kind` AND `payload.action` on a proposal waiting to go out. */
export const PROPOSAL_SEND_ACTION = "proposal_send";
/** The partial unique index that keeps pending send requests to one per proposal. */
export const PENDING_PROPOSAL_SEND_INDEX = "approvals_pending_proposal_send";
/** Stamped on the approval once carried out — the at-most-once claim. */
export const PROPOSAL_SEND_APPLIED_AT = "appliedAt";

type ApprovalRow = typeof schema.approvals.$inferSelect;

/**
 * What the card renders, read from our own rows at request time — never from
 * model text. The owner sees the price he is about to commit to and the
 * address it is about to go to, not the agent's account of them.
 */
export const ProposalSendPayload = z.object({
  action: z.literal(PROPOSAL_SEND_ACTION),
  proposalId: z.string().uuid(),
  reference: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  leadId: z.string().uuid().nullable(),
  clientId: z.string().uuid().nullable(),
  recipientName: z.string(),
  recipientEmail: z.string(),
  shape: z.string(),
  shapeLabel: z.string(),
  /** The one sentence the client reads on the PDF and in the email. */
  priceSentence: z.string(),
  dueOnAcceptancePence: z.number().int(),
  recurringMonthlyPence: z.number().int(),
  firstYearPence: z.number().int(),
  deliverables: z.array(z.string()),
  validUntil: z.string().nullable(),
  lineCount: z.number().int(),
  requestedByKind: ActorKindSchema,
  requestedById: z.string().nullable(),
});
export type ProposalSendPayload = z.infer<typeof ProposalSendPayload>;

export const RequestProposalApprovalInput = z.object({
  proposalId: z.string().uuid(),
  actorKind: ActorKindSchema.default("agent"),
  actorId: z.string().min(1).optional(),
  now: z.date().optional(),
});
export type RequestProposalApprovalInput = z.input<typeof RequestProposalApprovalInput>;

/**
 * Parks a draft in the approvals queue as a `proposal_send`.
 *
 * Nothing goes out here. The proposal stays a draft — it must, because
 * `sendProposal` only sends a draft, and because a rejected card should leave
 * the document exactly as editable as it was.
 *
 * Every refusal is a thing the owner would want to know before a client does,
 * and they are the same four `sendProposal` itself checks, made now rather
 * than after somebody has already pressed Approve: no draft, nobody to write
 * to, nothing priced, a validity date already gone. The fifth is the pending
 * index — one card per proposal, decided by the database.
 */
export async function requestProposalApproval(
  db: Db,
  organisationId: string,
  input: RequestProposalApprovalInput,
): Promise<{ proposal: ProposalRow; approval: ApprovalRow; payload: ProposalSendPayload }> {
  const v = RequestProposalApprovalInput.parse(input);
  const now = v.now ?? new Date();
  const proposal = await requireProposal(db, organisationId, v.proposalId);
  if (proposal.status !== "draft") {
    throw new ProposalRefused("not_sendable", `Proposal ${proposal.reference} has already been sent.`);
  }
  const detail = (await getProposalDetail(db, organisationId, proposal.id))!;
  if (!detail.recipient) {
    throw new ProposalRefused("no_recipient", "There is no email address on this lead or client to send the proposal to.");
  }
  if (isPricedAtNothing(detail.totals)) {
    throw new ProposalRefused("no_price", `Proposal ${proposal.reference} has nothing priced on it yet — add the lines first.`);
  }
  if (hasExpired(proposal, now)) {
    throw new ProposalRefused("expired", `Proposal ${proposal.reference} is dated to expire already — move the valid-until date first.`);
  }

  const payload: ProposalSendPayload = {
    action: PROPOSAL_SEND_ACTION,
    proposalId: proposal.id,
    reference: proposal.reference,
    title: proposal.title,
    summary: proposal.summary,
    leadId: proposal.leadId,
    clientId: proposal.clientId,
    recipientName: detail.recipient.name,
    recipientEmail: detail.recipient.email,
    shape: detail.totals.shape,
    shapeLabel: SHAPE_LABEL[detail.totals.shape],
    priceSentence: describePricing(detail.totals),
    dueOnAcceptancePence: detail.totals.dueOnAcceptancePence,
    recurringMonthlyPence: detail.totals.recurringMonthlyPence,
    firstYearPence: detail.totals.firstYearPence,
    deliverables: proposal.scope.deliverables,
    validUntil: proposal.validUntil,
    lineCount: detail.lines.length,
    requestedByKind: v.actorKind,
    requestedById: v.actorId ?? null,
  };
  const title = `Send proposal ${proposal.reference} to ${detail.recipient.name}: ${proposal.title}`;

  let approval: ApprovalRow;
  try {
    approval = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.insert(schema.approvals).values({
        organisationId, kind: PROPOSAL_SEND_ACTION, title, payload,
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "proposal.send_requested",
        targetType: PROPOSAL_TARGET_TYPE, targetId: proposal.id, after: row,
      });
      await recordActivity(tx, organisationId, {
        ...(proposal.clientId ? { clientId: proposal.clientId } : {}),
        actorKind: v.actorKind, actorId: v.actorId, kind: "proposal.send_requested",
        title: `Proposal ${proposal.reference} is waiting for approval to send`,
        link: "/approvals",
      });
      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ProposalRefused("already_pending", `Proposal ${proposal.reference} is already waiting for a decision.`);
    }
    throw error;
  }

  await notifyOwner(db, organisationId, {
    kind: "approval.requested",
    title: `Approve: send ${proposal.reference} to ${detail.recipient.name}`,
    body: `${proposal.title}. ${describePricing(detail.totals)} Approve to email ${detail.recipient.email}.`,
    link: "/approvals",
  });
  return { proposal, approval, payload };
}

export const ApplyProposalSendDecisionInput = z.object({
  approvalId: z.string().uuid(),
  /** The staff user who decided it — the same id `decideApproval` stamped. */
  actorId: z.string().min(1).optional(),
});
export type ApplyProposalSendDecisionInput = z.input<typeof ApplyProposalSendDecisionInput>;

export interface ApplyProposalSendDecisionResult {
  decision: "approved" | "rejected";
  proposalId: string;
  /** True when the proposal actually went out on this call. */
  sent: boolean;
  /** True when this approval had already been carried out; nothing was touched. */
  alreadyApplied: boolean;
}

/**
 * Carries out a decided `proposal_send`.
 *
 * **The send happens before the claim, not after.** Every other `apply…`
 * function in LaunchOS claims first, because what follows it is a database
 * write that cannot half-happen. This one renders a PDF and queues an email,
 * and a claim taken before that would mean a render that failed on a bad
 * minute left the approval marked applied and the client waiting for ever.
 * Sending first is safe in the other direction because `sendProposal` refuses
 * anything that is not a draft: a retry after a lost stamp finds the proposal
 * already `sent`, treats it as done, and stamps.
 *
 * A rejected card claims and stops — the draft is left exactly as it was, so
 * it can be edited and asked about again.
 */
export async function applyProposalSendDecision(
  db: Db,
  organisationId: string,
  input: ApplyProposalSendDecisionInput,
  deps?: ProposalDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplyProposalSendDecisionResult> {
  const v = ApplyProposalSendDecisionInput.parse(input);
  await assertOwned(db, organisationId, schema.approvals, v.approvalId);
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, v.approvalId), eq(schema.approvals.organisationId, organisationId)));
  if (!approval || approval.status === "pending") throw new Error(`approval ${v.approvalId} has not been decided`);
  const decision = approval.status;
  const payload = ProposalSendPayload.parse(approval.payload);
  if (approval.metadata[PROPOSAL_SEND_APPLIED_AT]) {
    return { decision, proposalId: payload.proposalId, sent: false, alreadyApplied: true };
  }

  let sent = false;
  if (decision === "approved") {
    try {
      await sendProposal(db, organisationId, {
        proposalId: payload.proposalId,
        actorKind: "user",
        ...(v.actorId ? { actorId: v.actorId } : {}),
      }, deps, env);
      sent = true;
    } catch (error) {
      // Already sent — a previous attempt got the mail away and lost the
      // stamp. Fall through and stamp it; anything else is a real failure and
      // must be retried, so the approval stays unapplied.
      if (!(error instanceof ProposalRefused) || error.reason !== "not_sendable") throw error;
    }
  }

  const claimed = await claim(db, organisationId, approval, decision, sent, v.actorId);
  if (!claimed) return { decision, proposalId: payload.proposalId, sent: false, alreadyApplied: true };
  if (decision === "rejected") {
    await recordActivity(db, organisationId, {
      ...(payload.clientId ? { clientId: payload.clientId } : {}),
      actorKind: "user", ...(v.actorId ? { actorId: v.actorId } : {}), kind: "proposal.send_rejected",
      title: `Proposal ${payload.reference} was not sent`,
      ...(approval.decisionNote ? { body: approval.decisionNote } : {}),
      link: `/proposals/${payload.proposalId}`,
    });
  }
  return { decision, proposalId: payload.proposalId, sent, alreadyApplied: false };
}

/** The at-most-once stamp, plus the audit row that says who decided and what happened. */
async function claim(
  db: Db,
  organisationId: string,
  approval: ApprovalRow,
  decision: "approved" | "rejected",
  sent: boolean,
  actorId: string | undefined,
): Promise<ApprovalRow | undefined> {
  const now = new Date();
  const stamp = { [PROPOSAL_SEND_APPLIED_AT]: now.toISOString(), appliedBy: actorId ?? null, sent };
  const [claimed] = await db.update(schema.approvals)
    .set({
      metadata: sql`coalesce(${schema.approvals.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`,
      updatedAt: now,
    })
    .where(and(
      eq(schema.approvals.id, approval.id),
      eq(schema.approvals.organisationId, organisationId),
      sql`(${schema.approvals.metadata}->>${PROPOSAL_SEND_APPLIED_AT}) IS NULL`,
    ))
    .returning();
  if (!claimed) return undefined;
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId, action: `approval.proposal_send_${decision}_applied`,
    targetType: "approval", targetId: approval.id, before: approval, after: claimed,
  });
  return claimed;
}

/**
 * Decided `proposal_send` cards nobody has carried out yet — the worker's
 * safety net under a decision whose `proposals.send` job never arrived.
 *
 * Both verdicts, because a rejected card still owes its timeline entry, and
 * because a card left unapplied keeps its slot in the pending index free but
 * its story untold.
 */
export async function proposalSendsAwaitingApplication(
  db: Db,
  organisationId: string,
  limit = 50,
): Promise<ApprovalRow[]> {
  return db.select().from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.kind, PROPOSAL_SEND_ACTION),
      sql`${schema.approvals.status} <> 'pending'`,
      sql`${schema.approvals.metadata}->>${PROPOSAL_SEND_APPLIED_AT} is null`,
    ))
    .orderBy(asc(schema.approvals.decidedAt), asc(schema.approvals.id))
    .limit(limit);
}
