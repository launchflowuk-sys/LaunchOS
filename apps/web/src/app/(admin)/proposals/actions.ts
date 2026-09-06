"use server";

import {
  addProposalLine,
  createProposal,
  ProposalRefused,
  removeProposalLine,
  updateProposal,
  updateProposalLine,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { installWebEnqueue } from "@/lib/queue";
import {
  type ActionResult,
  AddLineSchema,
  CreateProposalSchema,
  type CreateProposalValues,
  firstIssue,
  LineIdSchema,
  linesOfText,
  ProposalIdSchema,
  UpdateLineSchema,
  UpdateProposalSchema,
} from "./schemas";
import { queueProposalSend } from "./send-queue";

/**
 * Writing proposals from the admin screens.
 *
 * Gated on `billing`, like Invoices and Packages: a proposal is a price, and
 * accepting one opens a Checkout and puts a client on a retainer. Server
 * Actions accept direct POSTs, so the gate is here and not only on the nav
 * link that hides the module.
 *
 * Nothing here sets an amount. The three figures on a proposal are derived
 * from its lines by core, so the line editor is the only way to price one —
 * see `packages/core/src/proposals/pricing.ts`.
 */

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/**
 * A core refusal is written for the person reading the screen — "this proposal
 * has monthly lines, which a one-off proposal cannot carry" — so it goes
 * straight to the toast. Anything else is ours to log and answer plainly.
 */
function failed(error: unknown, fallback: string): ActionResult {
  if (error instanceof ProposalRefused) return { status: "error", message: error.message };
  console.error(`[proposals] ${fallback}`, { error });
  return { status: "error", message: fallback };
}

/** Both proposal screens, plus the dashboard's counts. */
function revalidateProposal(proposalId: string): void {
  revalidatePath("/proposals");
  revalidatePath(`/proposals/${proposalId}`);
}

/**
 * Drafts a proposal for a lead or a client and hands back its id so the form
 * can go straight to the editor. Nothing is priced yet: a new proposal has a
 * shape and a title, and the lines come next.
 */
export async function createProposalAction(values: CreateProposalValues): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = CreateProposalSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the details and try again") };
  const v = parsed.data;

  try {
    const { proposal } = await createProposal(getDb(), gate.session.organisationId, {
      ...(v.subjectKind === "lead" ? { leadId: v.subjectId } : { clientId: v.subjectId }),
      title: v.title,
      ...(v.summary ? { summary: v.summary } : {}),
      pricing: { shape: v.shape },
      ...(v.validUntil ? { validUntil: v.validUntil } : {}),
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidatePath("/proposals");
    revalidatePath(v.subjectKind === "lead" ? `/leads/${v.subjectId}` : `/clients/${v.subjectId}`);
    return { status: "ok", id: proposal.id };
  } catch (error) {
    return failed(error, "Could not draft the proposal");
  }
}

/** The wording, the scope, the terms and the validity date of a draft. */
export async function updateProposalAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = UpdateProposalSchema.safeParse({
    proposalId: value(formData, "proposalId"),
    title: value(formData, "title"),
    summary: value(formData, "summary"),
    deliverables: value(formData, "deliverables"),
    outOfScope: value(formData, "outOfScope"),
    timeline: value(formData, "timeline"),
    terms: value(formData, "terms"),
    validUntil: value(formData, "validUntil"),
    shape: value(formData, "shape"),
    vatNote: value(formData, "vatNote"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the proposal and try again") };
  const v = parsed.data;

  try {
    await updateProposal(getDb(), gate.session.organisationId, {
      proposalId: v.proposalId,
      title: v.title,
      summary: v.summary ?? null,
      scope: {
        deliverables: linesOfText(v.deliverables),
        outOfScope: linesOfText(v.outOfScope),
        timeline: v.timeline ?? "",
      },
      terms: v.terms ?? null,
      validUntil: v.validUntil ?? null,
      // The shape is the one part of the pricing a person sets; the amounts
      // are rewritten from the lines inside the same transaction.
      pricing: { shape: v.shape, ...(v.vatNote ? { vatNote: v.vatNote } : {}) },
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateProposal(v.proposalId);
    return { status: "ok", id: v.proposalId };
  } catch (error) {
    return failed(error, "Could not save the proposal");
  }
}

export async function addLineAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = AddLineSchema.safeParse({
    proposalId: value(formData, "proposalId"),
    kind: value(formData, "kind"),
    description: value(formData, "description"),
    quantity: value(formData, "quantity") || "1",
    unitPence: value(formData, "unitPence"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the line and try again") };
  const v = parsed.data;

  try {
    await addProposalLine(getDb(), gate.session.organisationId, {
      proposalId: v.proposalId,
      kind: v.kind,
      description: v.description,
      quantity: v.quantity,
      unitPence: v.unitPence,
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateProposal(v.proposalId);
    return { status: "ok", id: v.proposalId };
  } catch (error) {
    return failed(error, "Could not add the line");
  }
}

export async function updateLineAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = UpdateLineSchema.safeParse({
    proposalId: value(formData, "proposalId"),
    lineId: value(formData, "lineId"),
    kind: value(formData, "kind"),
    description: value(formData, "description"),
    quantity: value(formData, "quantity") || "1",
    unitPence: value(formData, "unitPence"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the line and try again") };
  const v = parsed.data;

  try {
    await updateProposalLine(getDb(), gate.session.organisationId, {
      proposalId: v.proposalId,
      lineId: v.lineId,
      kind: v.kind,
      description: v.description,
      quantity: v.quantity,
      unitPence: v.unitPence,
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateProposal(v.proposalId);
    return { status: "ok", id: v.proposalId };
  } catch (error) {
    return failed(error, "Could not save the line");
  }
}

export async function removeLineAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = LineIdSchema.safeParse({ proposalId: value(formData, "proposalId"), lineId: value(formData, "lineId") });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Could not remove the line") };
  const v = parsed.data;

  try {
    await removeProposalLine(getDb(), gate.session.organisationId, {
      proposalId: v.proposalId,
      lineId: v.lineId,
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateProposal(v.proposalId);
    return { status: "ok", id: v.proposalId };
  } catch (error) {
    return failed(error, "Could not remove the line");
  }
}

/**
 * Send.
 *
 * The web app cannot render a PDF, so this queues `proposals.send` for the
 * worker after checking every refusal core would raise — being told "on its
 * way" and then having nothing happen is the one outcome worth writing code
 * to avoid. The proposal stays a draft until the worker has actually sent it,
 * and the screen says so.
 */
export async function sendProposalAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("billing");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = ProposalIdSchema.safeParse({ proposalId: value(formData, "proposalId") });
  if (!parsed.success) return { status: "error", message: "Could not send that proposal" };
  const { proposalId } = parsed.data;

  // The send queues the client's email through the same bus every other
  // outbound message uses.
  installWebEnqueue();
  try {
    const queued = await queueProposalSend(gate.session.organisationId, proposalId, gate.session.userId);
    if (!queued.ok) return { status: "error", message: queued.message };
    revalidateProposal(proposalId);
    return { status: "ok", id: proposalId };
  } catch (error) {
    return failed(error, "Could not queue the proposal for sending");
  }
}
