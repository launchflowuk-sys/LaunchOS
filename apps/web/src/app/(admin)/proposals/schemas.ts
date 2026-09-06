import {
  type ProposalLineKind,
  proposalLineKindEnum,
  type ProposalPricingShape,
  proposalPricingShapeEnum,
  type ProposalStatus,
  proposalStatusEnum,
} from "@launchos/db/schema";
import { z } from "zod";

/**
 * The Proposals screens' contract, beside the actions rather than in them: a
 * `"use server"` module may only export async functions, and the pages, the
 * approval card and the tests all need these labels and bounds.
 *
 * Every schema mirrors the bounds `packages/core/src/proposals` already
 * enforces, so a mistyped figure is a sentence on the form rather than a
 * thrown Zod error from core.
 *
 * **Nothing here may import `@launchos/core`.** The line editor and the new
 * proposal form are client components and import this module, so anything it
 * pulls in lands in the browser bundle — and core's barrel reaches, through
 * the proposal document's shared letterhead, all the way to Playwright. The
 * two ceilings below are therefore copied rather than imported, and
 * `schemas.test.ts` — which runs in Node and may import core — asserts they
 * are still the same numbers.
 *
 * The enums come from `@launchos/db/schema` rather than from `@launchos/db`
 * for the same reason: the package root carries the Postgres client, and the
 * schema subpath is table definitions and nothing else.
 */

/** `MAX_LINE_QUANTITY` in `packages/core/src/proposals/pricing.ts`. */
export const MAX_LINE_QUANTITY = 999;
/** `MAX_UNIT_PENCE` in the same file: £100,000 on one line. */
export const MAX_UNIT_PENCE = 10_000_000;

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const PROPOSAL_STATUSES = proposalStatusEnum.enumValues;

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Opened",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

/** How each shape reads in a picker. The full sentence is core's `describePricing`. */
export const SHAPE_OPTION_LABEL: Record<ProposalPricingShape, string> = {
  monthly_on_delivery: "Monthly, starting on delivery",
  setup_plus_monthly: "Setup fee, then monthly",
  one_off: "One-off payment",
};

/** What each shape means, under the picker, in Shoji's words. */
export const SHAPE_OPTION_HINT: Record<ProposalPricingShape, string> = {
  monthly_on_delivery: "Nothing to pay today. The first month starts when the work goes live.",
  setup_plus_monthly: "A build fee on acceptance, then the retainer every month.",
  one_off: "A single price. Nothing recurring.",
};

/** The heading each kind of line prints under, matching the document. */
export const LINE_KIND_LABEL: Record<ProposalLineKind, string> = {
  setup: "One-off, to start",
  monthly: "Every month",
  one_off: "One-off",
};

const ShapeSchema = z.enum(proposalPricingShapeEnum.enumValues);
const LineKindSchema = z.enum(proposalLineKindEnum.enumValues);
const DateKey = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Give the date as YYYY-MM-DD");

/** A blank optional field posts an empty string; that has to be `undefined` before the rule runs. */
const Optional = (max: number, message?: string) =>
  z
    .string()
    .max(max, message)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined));

/**
 * Pounds in the form, pence in the database.
 *
 * The line editor asks for `1250.00` because that is what a person types off
 * an invoice; core stores integer pence. `Math.round` is what turns the one
 * into the other, and rounding here rather than truncating means £12.005 —
 * which a float can produce from "12.01" — lands on the penny above, not the
 * one below.
 */
export const PoundsSchema = z
  .string()
  .trim()
  .min(1, "Enter a price")
  .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), "Give the price in pounds, like 1250 or 1250.00")
  .transform((v) => Math.round(Number(v) * 100))
  .refine((pence) => pence <= MAX_UNIT_PENCE, `A single line cannot be more than £${(MAX_UNIT_PENCE / 100).toLocaleString("en-GB")}`);

/** One line's price back as the string the edit field shows. */
export function poundsField(pence: number): string {
  return (pence / 100).toFixed(2);
}

/** A textarea of "one per line" turned into the array core stores. Blank lines dropped. */
export function linesOfText(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 60);
}

export const CreateProposalSchema = z
  .object({
    subject: z.string().trim().min(1, "Choose the lead or client this is for"),
    title: z.string().trim().min(1, "Give the proposal a title").max(300),
    shape: ShapeSchema,
    validUntil: DateKey.optional(),
    summary: Optional(4000, "Keep the summary under 4000 characters"),
  })
  .transform((v) => {
    // The picker posts one value — `lead:<id>` or `client:<id>` — because a
    // proposal is for exactly one of the two and two selects would let
    // somebody choose both.
    const [kind, id] = v.subject.split(":", 2);
    return { ...v, subjectKind: kind === "lead" ? ("lead" as const) : ("client" as const), subjectId: id ?? "" };
  })
  .refine((v) => /^[0-9a-f-]{36}$/i.test(v.subjectId), { message: "Choose the lead or client this is for", path: ["subject"] });
export type CreateProposalValues = z.input<typeof CreateProposalSchema>;

export const UpdateProposalSchema = z.object({
  proposalId: z.string().uuid(),
  title: z.string().trim().min(1, "Give the proposal a title").max(300),
  summary: Optional(4000, "Keep the summary under 4000 characters"),
  deliverables: Optional(6000),
  outOfScope: Optional(6000),
  timeline: Optional(1000, "Keep the timing note under 1000 characters"),
  terms: Optional(20_000, "Keep the terms under 20,000 characters"),
  validUntil: DateKey.optional(),
  shape: ShapeSchema,
  vatNote: Optional(300),
});

export const AddLineSchema = z.object({
  proposalId: z.string().uuid(),
  kind: LineKindSchema,
  description: z.string().trim().min(1, "Say what the line is for").max(300),
  quantity: z.coerce.number().int().min(1, "The quantity is at least 1").max(MAX_LINE_QUANTITY),
  unitPence: PoundsSchema,
});

export const UpdateLineSchema = AddLineSchema.extend({ lineId: z.string().uuid() });

export const LineIdSchema = z.object({ proposalId: z.string().uuid(), lineId: z.string().uuid() });

export const ProposalIdSchema = z.object({ proposalId: z.string().uuid() });

/** The first Zod issue, which is the one for the field that was just touched. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}
