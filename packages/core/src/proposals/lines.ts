import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { PenceSchema, ProposalLineKindSchema, QuantitySchema, assertLineKindAllowed, pricingFromLines, proposalTotals, type ProposalTotals } from "./pricing.js";
import { PROPOSAL_EDITABLE_STATUSES } from "./crud.js";
import {
  ActorKindSchema,
  ProposalRefused,
  listProposalLines,
  requireProposal,
  type ProposalLineRow,
  type ProposalRow,
} from "./shared.js";

/**
 * The priced schedule under a proposal.
 *
 * Every one of these three writes ends the same way: the lines are re-read and
 * the proposal's `pricing` is rewritten from them, in the same transaction.
 * That is what makes the headline figures incapable of disagreeing with the
 * schedule — there is no path that changes one without the other.
 */

export const LINE_TARGET_TYPE = "proposal_line";

export interface ProposalLinesResult {
  proposal: ProposalRow;
  lines: ProposalLineRow[];
  totals: ProposalTotals;
}

const Actor = {
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
};

export const AddProposalLineInput = z.object({
  proposalId: z.string().uuid(),
  kind: ProposalLineKindSchema,
  description: z.string().trim().min(1, "a line needs a description").max(300),
  quantity: QuantitySchema.default(1),
  unitPence: PenceSchema,
  sort: z.number().int().min(0).max(999).optional(),
  ...Actor,
});
export type AddProposalLineInput = z.input<typeof AddProposalLineInput>;

/** A draft, or a refusal naming what is wrong. Shared by the three writes below. */
async function editableProposal(db: Db, organisationId: string, proposalId: string): Promise<ProposalRow> {
  const proposal = await requireProposal(db, organisationId, proposalId);
  if (!PROPOSAL_EDITABLE_STATUSES.includes(proposal.status)) {
    throw new ProposalRefused("not_editable", `Proposal ${proposal.reference} has been sent — its figures cannot change now.`);
  }
  return proposal;
}

/** Re-reads the lines and rewrites the proposal's derived pricing. In the caller's transaction. */
async function repriceProposal(db: Db, organisationId: string, proposal: ProposalRow): Promise<ProposalLinesResult> {
  const lines = await listProposalLines(db, organisationId, proposal.id);
  const pricing = pricingFromLines(proposal.pricing, lines);
  const [after] = await db.update(schema.proposals)
    .set({ pricing, updatedAt: new Date() })
    .where(and(eq(schema.proposals.id, proposal.id), eq(schema.proposals.organisationId, organisationId)))
    .returning();
  return { proposal: after!, lines, totals: proposalTotals(pricing.shape, lines) };
}

/**
 * Adds a line. The shape decides which kinds are allowed and refuses the rest
 * here, where the person can still see why — a `one_off` proposal never gets
 * a monthly line, so no reader ever has to work out what one would have meant.
 */
export async function addProposalLine(db: Db, organisationId: string, input: AddProposalLineInput): Promise<ProposalLinesResult> {
  const v = AddProposalLineInput.parse(input);
  const proposal = await editableProposal(db, organisationId, v.proposalId);
  assertLineKindAllowed(proposal.pricing.shape, v.kind);
  const existing = await listProposalLines(db, organisationId, proposal.id);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [line] = await tx.insert(schema.proposalLines).values({
      organisationId,
      proposalId: proposal.id,
      kind: v.kind,
      description: v.description,
      quantity: v.quantity,
      unitPence: v.unitPence,
      sort: v.sort ?? existing.length,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "proposal.line_added",
      targetType: LINE_TARGET_TYPE, targetId: line!.id, after: line,
    });
    return repriceProposal(tx, organisationId, proposal);
  });
}

export const UpdateProposalLineInput = z.object({
  proposalId: z.string().uuid(),
  lineId: z.string().uuid(),
  kind: ProposalLineKindSchema.optional(),
  description: z.string().trim().min(1).max(300).optional(),
  quantity: QuantitySchema.optional(),
  unitPence: PenceSchema.optional(),
  sort: z.number().int().min(0).max(999).optional(),
  ...Actor,
});
export type UpdateProposalLineInput = z.input<typeof UpdateProposalLineInput>;

/** Changes one line. `proposalId` is part of the key, so a line cannot be moved between proposals. */
export async function updateProposalLine(db: Db, organisationId: string, input: UpdateProposalLineInput): Promise<ProposalLinesResult> {
  const v = UpdateProposalLineInput.parse(input);
  const proposal = await editableProposal(db, organisationId, v.proposalId);
  if (v.kind) assertLineKindAllowed(proposal.pricing.shape, v.kind);
  const before = await lineOf(db, organisationId, proposal.id, v.lineId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.proposalLines)
      .set({
        ...(v.kind !== undefined ? { kind: v.kind } : {}),
        ...(v.description !== undefined ? { description: v.description } : {}),
        ...(v.quantity !== undefined ? { quantity: v.quantity } : {}),
        ...(v.unitPence !== undefined ? { unitPence: v.unitPence } : {}),
        ...(v.sort !== undefined ? { sort: v.sort } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.proposalLines.id, before.id),
        eq(schema.proposalLines.proposalId, proposal.id),
        eq(schema.proposalLines.organisationId, organisationId),
      ))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "proposal.line_updated",
      targetType: LINE_TARGET_TYPE, targetId: before.id, before, after,
    });
    return repriceProposal(tx, organisationId, proposal);
  });
}

export const RemoveProposalLineInput = z.object({
  proposalId: z.string().uuid(),
  lineId: z.string().uuid(),
  ...Actor,
});
export type RemoveProposalLineInput = z.input<typeof RemoveProposalLineInput>;

/**
 * Takes a line off a draft.
 *
 * Soft-deleted rather than removed, because `deleted_at` is what every other
 * table here means by "gone" and because the audit row's `before` is only
 * useful if the thing it describes can still be looked up.
 */
export async function removeProposalLine(db: Db, organisationId: string, input: RemoveProposalLineInput): Promise<ProposalLinesResult> {
  const v = RemoveProposalLineInput.parse(input);
  const proposal = await editableProposal(db, organisationId, v.proposalId);
  const before = await lineOf(db, organisationId, proposal.id, v.lineId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();
    const [after] = await tx.update(schema.proposalLines)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(
        eq(schema.proposalLines.id, before.id),
        eq(schema.proposalLines.proposalId, proposal.id),
        eq(schema.proposalLines.organisationId, organisationId),
      ))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "proposal.line_removed",
      targetType: LINE_TARGET_TYPE, targetId: before.id, before, after,
    });
    return repriceProposal(tx, organisationId, proposal);
  });
}

async function lineOf(db: Db, organisationId: string, proposalId: string, lineId: string): Promise<ProposalLineRow> {
  const [row] = await db.select().from(schema.proposalLines)
    .where(and(
      eq(schema.proposalLines.id, lineId),
      eq(schema.proposalLines.proposalId, proposalId),
      eq(schema.proposalLines.organisationId, organisationId),
      isNull(schema.proposalLines.deletedAt),
    ));
  if (!row) throw new ProposalRefused("not_found", "That line could not be found on this proposal.");
  return row;
}
