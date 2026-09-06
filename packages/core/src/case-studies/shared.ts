import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { z } from "zod";
import { slugify } from "../clients/slug.js";

/**
 * The pieces every module in this folder shares: what a row is, what a refusal
 * is, and the two lookups that take an id or a slug.
 */

export { CASE_STUDY_PUBLIC_STATUSES } from "@launchos/db/schema";

export type CaseStudyRow = typeof schema.caseStudies.$inferSelect;

export const ActorKindSchema = z.enum(["user", "client", "agent", "system"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** The audit target type every case study action is recorded under. */
export const CASE_STUDY_TARGET_TYPE = "case_study";

/** Where a published story is read. The web task owns the route; this is the shape of it. */
export const CASE_STUDY_PUBLIC_PATH = "/work";

export class CaseStudyRefused extends Error {
  constructor(readonly reason: "not_found" | "slug_taken" | "not_publishable", message: string) {
    super(message);
    this.name = "CaseStudyRefused";
  }
}

export const CaseStudyBriefInput = z.object({
  client: z.string().trim().max(4000).default(""),
  problem: z.string().trim().max(4000).default(""),
  built: z.string().trim().max(8000).default(""),
  results: z.string().trim().max(4000).default(""),
});
export type CaseStudyBriefInput = z.input<typeof CaseStudyBriefInput>;

export const CaseStudyScreenshotsInput = z.object({
  desktop: z.string().trim().max(500).optional(),
  mobile: z.string().trim().max(500).optional(),
});
export type CaseStudyScreenshotsInput = z.input<typeof CaseStudyScreenshotsInput>;

export const CaseStudyPoweredByInput = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().max(500),
  logo: z.string().trim().max(500),
  logoWidth: z.number().int().min(1).max(10_000),
  logoHeight: z.number().int().min(1).max(10_000),
});
export type CaseStudyPoweredByInput = z.input<typeof CaseStudyPoweredByInput>;

/** One story in this organisation. Null when it is another tenant's, or gone. */
export async function getCaseStudy(db: Db, organisationId: string, caseStudyId: string): Promise<CaseStudyRow | null> {
  const [row] = await db
    .select()
    .from(schema.caseStudies)
    .where(and(
      eq(schema.caseStudies.id, caseStudyId),
      eq(schema.caseStudies.organisationId, organisationId),
      isNull(schema.caseStudies.deletedAt),
    ));
  return row ?? null;
}

/** The same, or a refusal — for the callers that always need one. */
export async function requireCaseStudy(db: Db, organisationId: string, caseStudyId: string): Promise<CaseStudyRow> {
  const row = await getCaseStudy(db, organisationId, caseStudyId);
  if (!row) throw new CaseStudyRefused("not_found", "That case study could not be found.");
  return row;
}

/** By slug — how the public page finds one, and how the seed checks for itself. */
export async function getCaseStudyBySlug(db: Db, organisationId: string, slug: string): Promise<CaseStudyRow | null> {
  const [row] = await db
    .select()
    .from(schema.caseStudies)
    .where(and(
      eq(schema.caseStudies.organisationId, organisationId),
      eq(schema.caseStudies.slug, slug),
      isNull(schema.caseStudies.deletedAt),
    ));
  return row ?? null;
}

/** The story written about one project, if there is one. At most one, by index. */
export async function getCaseStudyForProject(db: Db, organisationId: string, projectId: string): Promise<CaseStudyRow | null> {
  const [row] = await db
    .select()
    .from(schema.caseStudies)
    .where(and(
      eq(schema.caseStudies.organisationId, organisationId),
      eq(schema.caseStudies.projectId, projectId),
      isNull(schema.caseStudies.deletedAt),
    ));
  return row ?? null;
}

/**
 * The first free slug in this organisation: "kd-essex", then "kd-essex-2".
 *
 * A slug is a public URL that gets shared, printed and linked to, so it is
 * allocated once and never quietly reassigned — which is why this only ever
 * looks for a *free* one and never reuses a soft-deleted row's. The unique
 * index decides an actual race; this makes the common case pleasant.
 */
export async function uniqueCaseStudySlug(db: Db, organisationId: string, desired: string): Promise<string> {
  const base = slugify(desired) || "case-study";
  // `base` is already [a-z0-9-] only, so it carries no LIKE metacharacters.
  const rows = await db
    .select({ slug: schema.caseStudies.slug })
    .from(schema.caseStudies)
    .where(and(eq(schema.caseStudies.organisationId, organisationId), like(schema.caseStudies.slug, `${base}%`)));
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new CaseStudyRefused("slug_taken", `Could not allocate a free web address for "${desired}".`);
}
