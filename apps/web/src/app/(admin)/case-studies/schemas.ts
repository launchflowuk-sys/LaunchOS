import {
  type CaseStudyDeliveryStatus,
  caseStudyDeliveryStatusEnum,
  type CaseStudyKind,
  caseStudyKindEnum,
  type CaseStudyStatus,
  caseStudyStatusEnum,
} from "@launchos/db/schema";
import { z } from "zod";

/**
 * The Case studies screens' contract, beside the actions rather than in them:
 * a `"use server"` module may only export async functions.
 *
 * Every bound mirrors `packages/core/src/case-studies/crud.ts`, so copy that is
 * too long is a sentence on the form rather than a thrown Zod error from core.
 * **Nothing here may import `@launchos/core`** — the reorder controls are a
 * client component and import this module.
 */

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const CASE_STUDY_STATUSES = caseStudyStatusEnum.enumValues;
export const CASE_STUDY_DELIVERY_STATUSES = caseStudyDeliveryStatusEnum.enumValues;
export const CASE_STUDY_KINDS = caseStudyKindEnum.enumValues;

/**
 * `unlisted` is a story with a public URL that is deliberately not on the Work
 * index — a client who is happy for us to show it but not to advertise it.
 */
export const CASE_STUDY_STATUS_LABEL: Record<CaseStudyStatus, string> = {
  draft: "Draft",
  review: "In review",
  published: "Published",
  unlisted: "Unlisted",
};

/** The same words the public card prints. The hyphens are the database's. */
export const DELIVERY_STATUS_LABEL: Record<CaseStudyDeliveryStatus, string> = {
  live: "Live",
  "in-build": "In build",
  "in-testing": "In testing",
  discovery: "In discovery",
};

export const KIND_LABEL: Record<CaseStudyKind, string> = {
  client: "Client build",
  product: "Our own product",
};

/** `MAX_STACK` and `MAX_FACTS` in `packages/core/src/case-studies/crud.ts`. */
export const MAX_STACK = 40;
export const MAX_FACTS = 12;

const optional = (max: number) => z.string().trim().max(max).optional();

export const UpdateCaseStudySchema = z.object({
  caseStudyId: z.string().uuid(),
  slug: z.string().trim().min(1, "a story needs a web address").max(120),
  name: z.string().trim().min(1, "a story needs a name").max(300),
  clientName: optional(300),
  sector: z.string().trim().max(200).default(""),
  summary: z.string().trim().max(1000).default(""),
  briefClient: optional(4000),
  briefProblem: optional(4000),
  briefBuilt: optional(8000),
  briefResults: optional(4000),
  stack: optional(4000),
  year: z.union([z.literal(""), z.coerce.number().int().min(1990).max(2200)]).optional(),
  url: optional(500),
  screenshotDesktop: optional(500),
  screenshotMobile: optional(500),
  kind: z.enum(CASE_STUDY_KINDS),
  status: z.enum(CASE_STUDY_STATUSES),
  deliveryStatus: z.enum(CASE_STUDY_DELIVERY_STATUSES),
  featured: z.boolean().default(false),
  charity: z.boolean().default(false),
  domain: optional(300),
  tagline: optional(500),
  description: optional(8000),
  facts: optional(4000),
  poweredByName: optional(120),
  poweredByUrl: optional(500),
  poweredByLogo: optional(500),
  poweredByWidth: z.union([z.literal(""), z.coerce.number().int().min(1).max(10_000)]).optional(),
  poweredByHeight: z.union([z.literal(""), z.coerce.number().int().min(1).max(10_000)]).optional(),
});

export const SetFeaturedSchema = z.object({
  caseStudyId: z.string().uuid(),
  featured: z.boolean(),
});

export const SetStatusSchema = z.object({
  caseStudyId: z.string().uuid(),
  status: z.enum(CASE_STUDY_STATUSES),
});

export const ReorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * One item per line, blanks dropped. The stack and the facts are lists on the
 * card and a textarea on the form: a repeatable field for six words is more
 * clicks than typing them, and this is the same shape the proposal editor uses
 * for its deliverables.
 */
export function linesOfText(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

export function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === "on" || formData.get(name) === "true";
}

export function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
