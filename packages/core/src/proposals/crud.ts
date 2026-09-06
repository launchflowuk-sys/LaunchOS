import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ProposalLineKind, ProposalPricing, ProposalPricingShape, ProposalScope, ProposalStatus } from "@launchos/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { addDaysToKey, keyOfParts, zonedDateKey } from "../meetings/time.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import {
  DEFAULT_VAT_NOTE,
  LINE_KINDS_FOR_SHAPE,
  PenceSchema,
  ProposalLineKindSchema,
  ProposalPricingInput,
  QuantitySchema,
  SHAPE_LABEL,
  pricingFromLines,
  proposalTotals,
  type ProposalTotals,
} from "./pricing.js";
import {
  ActorKindSchema,
  PROPOSAL_TARGET_TYPE,
  ProposalRefused,
  getProposalAcceptance,
  getProposalByToken,
  isUniqueViolation,
  listProposalLines,
  mintProposalToken,
  nextProposalReference,
  proposalRecipient,
  requireProposal,
  type ProposalAcceptanceRow,
  type ProposalLineRow,
  type ProposalRow,
} from "./shared.js";

/**
 * Writing a proposal: create, amend, and read back.
 *
 * **A proposal is editable while it is a draft and not afterwards.** Once it
 * has been sent, a client is reading a PDF with a reference number on it and
 * a copy in their inbox; letting the wording or the price change underneath
 * that would mean the document they accept is not the document they were sent.
 * To change a sent proposal, write another one — which is what a person would
 * do on paper, and costs one click.
 */

/** The statuses whose wording and figures may still change. */
export const PROPOSAL_EDITABLE_STATUSES: readonly ProposalStatus[] = ["draft"];

/** How long a proposal stands when nobody says. A month is Shoji's usual answer. */
export const DEFAULT_VALIDITY_DAYS = 30;

const DateKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "validUntil must be YYYY-MM-DD");

export const ProposalScopeInput = z.object({
  deliverables: z.array(z.string().trim().min(1).max(300)).max(60).default([]),
  outOfScope: z.array(z.string().trim().min(1).max(300)).max(60).default([]),
  timeline: z.string().trim().max(1000).default(""),
});
export type ProposalScopeInput = z.input<typeof ProposalScopeInput>;

export const ProposalLineInput = z.object({
  kind: ProposalLineKindSchema,
  description: z.string().trim().min(1, "a line needs a description").max(300),
  quantity: QuantitySchema.default(1),
  unitPence: PenceSchema,
  sort: z.number().int().min(0).max(999).optional(),
});
export type ProposalLineInput = z.input<typeof ProposalLineInput>;

export const CreateProposalInput = z.object({
  leadId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  title: z.string().trim().min(1, "a proposal needs a title").max(300),
  summary: z.string().trim().max(4000).optional(),
  scope: ProposalScopeInput.optional(),
  pricing: ProposalPricingInput,
  terms: z.string().trim().max(20_000).optional(),
  /** `YYYY-MM-DD`, London. Defaults to a month from today. */
  validUntil: DateKeySchema.optional(),
  lines: z.array(ProposalLineInput).max(60).default([]),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type CreateProposalInput = z.input<typeof CreateProposalInput>;

export interface ProposalDetail {
  proposal: ProposalRow;
  lines: ProposalLineRow[];
  totals: ProposalTotals;
  acceptance: ProposalAcceptanceRow | null;
  recipient: { name: string; email: string } | null;
}

function scopeOf(input: ProposalScopeInput | undefined): ProposalScope {
  const parsed = ProposalScopeInput.parse(input ?? {});
  return { deliverables: parsed.deliverables, outOfScope: parsed.outOfScope, timeline: parsed.timeline };
}

/** The lines a shape does not allow, named — so a refusal says which ones. */
function offendingKinds(shape: ProposalPricingShape, lines: readonly { kind: ProposalLineKind }[]): string[] {
  const allowed = LINE_KINDS_FOR_SHAPE[shape];
  return [...new Set(lines.map((line) => line.kind).filter((kind) => !allowed.includes(kind)))];
}

/** A whole `ProposalPricing` from the parts a caller may set. Amounts come from the lines. */
function pricingBase(
  shape: ProposalPricingShape,
  packageId: string | null | undefined,
  vatNote: string,
): ProposalPricing {
  return {
    shape,
    ...(packageId ? { packageId } : {}),
    setupPence: 0,
    monthlyPence: 0,
    oneOffPence: 0,
    currency: "GBP",
    vatNote,
  };
}

/**
 * Creates a draft with its lines and its derived price, in one transaction.
 *
 * The reference and the public token are minted here rather than at send time,
 * so a draft can be previewed and talked about before anybody commits to it.
 * A reference race — two proposals created in the same second — loses to the
 * unique index and is retried once with the number that is now next; a third
 * collision is a real problem and is allowed to surface.
 */
export async function createProposal(db: Db, organisationId: string, input: CreateProposalInput): Promise<ProposalDetail> {
  const v = CreateProposalInput.parse(input);
  if (!v.leadId && !v.clientId) {
    throw new ProposalRefused("not_found", "A proposal needs a lead or a client to be for.");
  }
  if (v.leadId) await assertOwned(db, organisationId, schema.leads, v.leadId);
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.pricing.packageId) await assertOwned(db, organisationId, schema.packages, v.pricing.packageId);

  const bad = offendingKinds(v.pricing.shape, v.lines);
  if (bad.length > 0) {
    throw new ProposalRefused(
      "shape_mismatch",
      `A ${SHAPE_LABEL[v.pricing.shape].toLowerCase()} proposal cannot carry ${bad.join(" or ")} lines.`,
    );
  }

  const now = v.now ?? new Date();
  const validUntil = v.validUntil ?? keyOfParts(addDaysToKey(zonedDateKey(now, "Europe/London"), DEFAULT_VALIDITY_DAYS));
  const pricing = pricingFromLines(
    pricingBase(v.pricing.shape, v.pricing.packageId, v.pricing.vatNote || DEFAULT_VAT_NOTE),
    v.lines,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reference = await nextProposalReference(db, organisationId, now);
    try {
      return await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [proposal] = await tx.insert(schema.proposals).values({
          organisationId,
          leadId: v.leadId ?? null,
          clientId: v.clientId ?? null,
          reference,
          title: v.title,
          summary: v.summary ?? null,
          scope: scopeOf(v.scope),
          pricing,
          terms: v.terms ?? null,
          validUntil,
          status: "draft",
          publicToken: mintProposalToken(),
          packageId: v.pricing.packageId ?? null,
          createdByUserId: v.actorKind === "user" ? (v.actorId ?? null) : null,
        }).returning();

        const lines = v.lines.length === 0 ? [] : await tx.insert(schema.proposalLines).values(
          v.lines.map((line, index) => ({
            organisationId,
            proposalId: proposal!.id,
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unitPence: line.unitPence,
            sort: line.sort ?? index,
          })),
        ).returning();

        await recordAudit(tx, organisationId, {
          actorKind: v.actorKind, actorId: v.actorId, action: "proposal.created",
          targetType: PROPOSAL_TARGET_TYPE, targetId: proposal!.id, after: proposal,
        });
        await recordActivity(tx, organisationId, {
          ...(v.clientId ? { clientId: v.clientId } : {}),
          actorKind: v.actorKind, actorId: v.actorId, kind: "proposal.created",
          title: `Proposal ${reference} drafted: ${v.title}`,
          link: `/proposals/${proposal!.id}`,
        });

        return {
          proposal: proposal!,
          lines: [...lines].sort((a, b) => a.sort - b.sort),
          totals: proposalTotals(pricing.shape, lines),
          acceptance: null,
          recipient: await proposalRecipient(tx, organisationId, proposal!),
        };
      });
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new ProposalRefused("not_found", "A reference could not be issued for this proposal — please try again.");
}

export const UpdateProposalInput = z.object({
  proposalId: z.string().uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  summary: z.string().trim().max(4000).nullish(),
  scope: ProposalScopeInput.optional(),
  pricing: ProposalPricingInput.partial().optional(),
  terms: z.string().trim().max(20_000).nullish(),
  validUntil: DateKeySchema.nullish(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type UpdateProposalInput = z.input<typeof UpdateProposalInput>;

/**
 * Amends a draft.
 *
 * The three amounts are not in the input: they are derived from the lines and
 * rewritten here, so the figures on the row can never disagree with the
 * schedule beneath them. Changing the shape under existing lines is refused
 * rather than silently dropping them — a `one_off` that quietly ate a £250
 * monthly line is a worse outcome than an error message.
 */
export async function updateProposal(db: Db, organisationId: string, input: UpdateProposalInput): Promise<ProposalDetail> {
  const v = UpdateProposalInput.parse(input);
  const before = await requireProposal(db, organisationId, v.proposalId);
  if (!PROPOSAL_EDITABLE_STATUSES.includes(before.status)) {
    throw new ProposalRefused("not_editable", `Proposal ${before.reference} has been sent — write a new one rather than changing this.`);
  }
  if (v.pricing?.packageId) await assertOwned(db, organisationId, schema.packages, v.pricing.packageId);

  const lines = await listProposalLines(db, organisationId, before.id);
  const shape = v.pricing?.shape ?? before.pricing.shape;
  const bad = offendingKinds(shape, lines);
  if (bad.length > 0) {
    throw new ProposalRefused(
      "shape_mismatch",
      `This proposal has ${bad.join(" and ")} lines, which a ${SHAPE_LABEL[shape].toLowerCase()} proposal cannot carry — remove them first.`,
    );
  }

  const pricing = pricingFromLines(
    pricingBase(
      shape,
      "packageId" in (v.pricing ?? {}) ? v.pricing?.packageId : before.pricing.packageId,
      v.pricing?.vatNote ?? before.pricing.vatNote,
    ),
    lines,
  );

  const updated = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.proposals)
      .set({
        ...(v.title !== undefined ? { title: v.title } : {}),
        ...(v.summary !== undefined ? { summary: v.summary ?? null } : {}),
        ...(v.scope !== undefined ? { scope: scopeOf(v.scope) } : {}),
        ...(v.terms !== undefined ? { terms: v.terms ?? null } : {}),
        ...(v.validUntil !== undefined ? { validUntil: v.validUntil ?? null } : {}),
        pricing,
        packageId: pricing.packageId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.proposals.id, before.id), eq(schema.proposals.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "proposal.updated",
      targetType: PROPOSAL_TARGET_TYPE, targetId: before.id, before, after,
    });
    return after!;
  });

  return {
    proposal: updated,
    lines,
    totals: proposalTotals(pricing.shape, lines),
    acceptance: null,
    recipient: await proposalRecipient(db, organisationId, updated),
  };
}

export const ListProposalsInput = z.object({
  status: z.enum(schema.proposalStatusEnum.enumValues).optional(),
  leadId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListProposalsInput = z.input<typeof ListProposalsInput>;

/** Newest first — the admin list, and the strip on a lead or a client page. */
export async function listProposals(db: Db, organisationId: string, input: ListProposalsInput = {}): Promise<ProposalRow[]> {
  const v = ListProposalsInput.parse(input);
  return db.select().from(schema.proposals)
    .where(and(
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
      v.status ? eq(schema.proposals.status, v.status) : undefined,
      v.leadId ? eq(schema.proposals.leadId, v.leadId) : undefined,
      v.clientId ? eq(schema.proposals.clientId, v.clientId) : undefined,
    ))
    .orderBy(desc(schema.proposals.createdAt), desc(schema.proposals.id))
    .limit(v.limit);
}

/** Everything one proposal screen needs, in one call. */
export async function getProposalDetail(db: Db, organisationId: string, proposalId: string): Promise<ProposalDetail | null> {
  const [proposal] = await db.select().from(schema.proposals)
    .where(and(
      eq(schema.proposals.id, proposalId),
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
    ));
  if (!proposal) return null;
  const lines = await listProposalLines(db, organisationId, proposal.id);
  return {
    proposal,
    lines,
    totals: proposalTotals(proposal.pricing.shape, lines),
    acceptance: await getProposalAcceptance(db, organisationId, proposal.id),
    recipient: await proposalRecipient(db, organisationId, proposal),
  };
}

/**
 * The same detail, by public token, for a reader with no account.
 *
 * The token is the argument because it is the only thing that caller legally
 * holds: a public route that took an id could be handed one it guessed, and
 * this way there is nothing to guess.
 */
export async function getPublicProposal(db: Db, token: string): Promise<ProposalDetail | null> {
  const proposal = await getProposalByToken(db, token);
  if (!proposal) return null;
  return getProposalDetail(db, proposal.organisationId, proposal.id);
}
