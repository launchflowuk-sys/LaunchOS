import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { CaseStudyBrief, CaseStudyPoweredBy, CaseStudyScreenshots } from "@launchos/db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import {
  ActorKindSchema,
  CASE_STUDY_TARGET_TYPE,
  CaseStudyBriefInput,
  CaseStudyPoweredByInput,
  CaseStudyRefused,
  CaseStudyScreenshotsInput,
  getCaseStudyForProject,
  requireCaseStudy,
  uniqueCaseStudySlug,
  type CaseStudyRow,
} from "./shared.js";

/**
 * Writing the portfolio: create a story, edit every field of it, order the
 * page, and decide what the public sees.
 *
 * Unlike a proposal, a case study stays editable for ever. It is our own copy
 * about our own work, nobody has signed it, and the whole point of publishing
 * from a table rather than a file is that Shoji can fix a typo on a Sunday
 * without a deploy.
 */

const MAX_STACK = 40;
const MAX_FACTS = 12;

const StackSchema = z.array(z.string().trim().min(1).max(120)).max(MAX_STACK);
const FactsSchema = z.array(z.string().trim().min(1).max(300)).max(MAX_FACTS);

/** The fields both create and update accept, so the two cannot drift apart. */
const CaseStudyFields = {
  name: z.string().trim().min(1, "a case study needs a name").max(300),
  clientName: z.string().trim().max(300).nullish(),
  sector: z.string().trim().max(200),
  summary: z.string().trim().max(1000),
  brief: CaseStudyBriefInput,
  stack: StackSchema,
  year: z.number().int().min(1990).max(2200).nullish(),
  url: z.string().trim().max(500).nullish(),
  screenshots: CaseStudyScreenshotsInput,
  featured: z.boolean(),
  kind: z.enum(schema.caseStudyKindEnum.enumValues),
  status: z.enum(schema.caseStudyStatusEnum.enumValues),
  deliveryStatus: z.enum(schema.caseStudyDeliveryStatusEnum.enumValues),
  charity: z.boolean(),
  poweredBy: CaseStudyPoweredByInput.nullish(),
  domain: z.string().trim().max(300).nullish(),
  tagline: z.string().trim().max(500).nullish(),
  description: z.string().trim().max(8000).nullish(),
  facts: FactsSchema,
  sort: z.number().int().min(0).max(9999),
};

export const CreateCaseStudyInput = z.object({
  clientId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  slug: z.string().trim().max(120).optional(),
  name: CaseStudyFields.name,
  clientName: CaseStudyFields.clientName,
  sector: CaseStudyFields.sector.default(""),
  summary: CaseStudyFields.summary.default(""),
  brief: CaseStudyFields.brief.optional(),
  stack: CaseStudyFields.stack.default([]),
  year: CaseStudyFields.year,
  url: CaseStudyFields.url,
  screenshots: CaseStudyFields.screenshots.optional(),
  featured: CaseStudyFields.featured.default(false),
  kind: CaseStudyFields.kind.default("client"),
  status: CaseStudyFields.status.default("draft"),
  deliveryStatus: CaseStudyFields.deliveryStatus.default("live"),
  charity: CaseStudyFields.charity.default(false),
  poweredBy: CaseStudyFields.poweredBy,
  domain: CaseStudyFields.domain,
  tagline: CaseStudyFields.tagline,
  description: CaseStudyFields.description,
  facts: CaseStudyFields.facts.default([]),
  sort: CaseStudyFields.sort.optional(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type CreateCaseStudyInput = z.input<typeof CreateCaseStudyInput>;

function briefOf(input: CaseStudyBriefInput | undefined): CaseStudyBrief {
  const parsed = CaseStudyBriefInput.parse(input ?? {});
  return { client: parsed.client, problem: parsed.problem, built: parsed.built, results: parsed.results };
}

function screenshotsOf(input: CaseStudyScreenshotsInput | undefined): CaseStudyScreenshots {
  const parsed = CaseStudyScreenshotsInput.parse(input ?? {});
  return {
    ...(parsed.desktop ? { desktop: parsed.desktop } : {}),
    ...(parsed.mobile ? { mobile: parsed.mobile } : {}),
  };
}

function poweredByOf(input: CaseStudyPoweredByInput | null | undefined): CaseStudyPoweredBy | null {
  if (!input) return null;
  const v = CaseStudyPoweredByInput.parse(input);
  return { name: v.name, url: v.url, logo: v.logo, logoWidth: v.logoWidth, logoHeight: v.logoHeight };
}

/** The next place on the page, so a new story lands at the bottom rather than on top of one. */
async function nextSort(db: Db, organisationId: string): Promise<number> {
  const rows = await db
    .select({ sort: schema.caseStudies.sort })
    .from(schema.caseStudies)
    .where(eq(schema.caseStudies.organisationId, organisationId));
  return rows.reduce((highest, row) => Math.max(highest, row.sort), -1) + 1;
}

export async function createCaseStudy(db: Db, organisationId: string, input: CreateCaseStudyInput): Promise<CaseStudyRow> {
  const v = CreateCaseStudyInput.parse(input);
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.projectId) await assertOwned(db, organisationId, schema.projects, v.projectId);
  const slug = await uniqueCaseStudySlug(db, organisationId, v.slug ?? v.name);
  const now = v.now ?? new Date();
  const sort = v.sort ?? (await nextSort(db, organisationId));

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.caseStudies).values({
      organisationId,
      clientId: v.clientId ?? null,
      projectId: v.projectId ?? null,
      slug,
      name: v.name,
      clientName: v.clientName ?? null,
      sector: v.sector,
      summary: v.summary,
      brief: briefOf(v.brief),
      stack: [...v.stack],
      year: v.year ?? null,
      url: v.url ?? null,
      screenshots: screenshotsOf(v.screenshots),
      featured: v.featured,
      kind: v.kind,
      status: v.status,
      deliveryStatus: v.deliveryStatus,
      charity: v.charity,
      poweredBy: poweredByOf(v.poweredBy),
      domain: v.domain ?? null,
      tagline: v.tagline ?? null,
      description: v.description ?? null,
      facts: [...v.facts],
      sort,
      publishedAt: v.status === "published" ? now : null,
    }).returning();

    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "case_study.created",
      targetType: CASE_STUDY_TARGET_TYPE, targetId: row!.id, after: row,
    });
    if (v.clientId) {
      await recordActivity(tx, organisationId, {
        clientId: v.clientId, actorKind: v.actorKind, actorId: v.actorId, kind: "case_study.created",
        title: `Case study started: ${v.name}`,
        link: `/case-studies/${row!.id}`,
      });
    }
    return row!;
  });
}

export const UpdateCaseStudyInput = z.object({
  caseStudyId: z.string().uuid(),
  clientId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  slug: z.string().trim().min(1).max(120).optional(),
  name: CaseStudyFields.name.optional(),
  clientName: CaseStudyFields.clientName,
  sector: CaseStudyFields.sector.optional(),
  summary: CaseStudyFields.summary.optional(),
  brief: CaseStudyFields.brief.optional(),
  stack: CaseStudyFields.stack.optional(),
  year: CaseStudyFields.year,
  url: CaseStudyFields.url,
  screenshots: CaseStudyFields.screenshots.optional(),
  featured: CaseStudyFields.featured.optional(),
  kind: CaseStudyFields.kind.optional(),
  status: CaseStudyFields.status.optional(),
  deliveryStatus: CaseStudyFields.deliveryStatus.optional(),
  charity: CaseStudyFields.charity.optional(),
  poweredBy: CaseStudyFields.poweredBy,
  domain: CaseStudyFields.domain,
  tagline: CaseStudyFields.tagline,
  description: CaseStudyFields.description,
  facts: CaseStudyFields.facts.optional(),
  sort: CaseStudyFields.sort.optional(),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type UpdateCaseStudyInput = z.input<typeof UpdateCaseStudyInput>;

/**
 * Edits any field, including the status.
 *
 * `published_at` is stamped by the first move to `published` and never
 * rewritten afterwards: it is the date the story went up, which is what a
 * sorted index and a sitemap both want, and unpublishing to fix a sentence
 * should not make a two-year-old story look new when it comes back.
 */
export async function updateCaseStudy(db: Db, organisationId: string, input: UpdateCaseStudyInput): Promise<CaseStudyRow> {
  const v = UpdateCaseStudyInput.parse(input);
  const before = await requireCaseStudy(db, organisationId, v.caseStudyId);
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.projectId) await assertOwned(db, organisationId, schema.projects, v.projectId);
  const slug = v.slug && v.slug !== before.slug ? await uniqueCaseStudySlug(db, organisationId, v.slug) : undefined;
  const now = v.now ?? new Date();
  const publishing = v.status === "published" && before.publishedAt === null;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.caseStudies)
      .set({
        ...(v.clientId !== undefined ? { clientId: v.clientId ?? null } : {}),
        ...(v.projectId !== undefined ? { projectId: v.projectId ?? null } : {}),
        ...(slug ? { slug } : {}),
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.clientName !== undefined ? { clientName: v.clientName ?? null } : {}),
        ...(v.sector !== undefined ? { sector: v.sector } : {}),
        ...(v.summary !== undefined ? { summary: v.summary } : {}),
        ...(v.brief !== undefined ? { brief: briefOf(v.brief) } : {}),
        ...(v.stack !== undefined ? { stack: [...v.stack] } : {}),
        ...(v.year !== undefined ? { year: v.year ?? null } : {}),
        ...(v.url !== undefined ? { url: v.url ?? null } : {}),
        ...(v.screenshots !== undefined ? { screenshots: screenshotsOf(v.screenshots) } : {}),
        ...(v.featured !== undefined ? { featured: v.featured } : {}),
        ...(v.kind !== undefined ? { kind: v.kind } : {}),
        ...(v.status !== undefined ? { status: v.status } : {}),
        ...(v.deliveryStatus !== undefined ? { deliveryStatus: v.deliveryStatus } : {}),
        ...(v.charity !== undefined ? { charity: v.charity } : {}),
        ...(v.poweredBy !== undefined ? { poweredBy: poweredByOf(v.poweredBy) } : {}),
        ...(v.domain !== undefined ? { domain: v.domain ?? null } : {}),
        ...(v.tagline !== undefined ? { tagline: v.tagline ?? null } : {}),
        ...(v.description !== undefined ? { description: v.description ?? null } : {}),
        ...(v.facts !== undefined ? { facts: [...v.facts] } : {}),
        ...(v.sort !== undefined ? { sort: v.sort } : {}),
        ...(publishing ? { publishedAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(schema.caseStudies.id, before.id), eq(schema.caseStudies.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId,
      action: v.status && v.status !== before.status ? `case_study.${v.status}` : "case_study.updated",
      targetType: CASE_STUDY_TARGET_TYPE, targetId: before.id, before, after,
    });
    return after!;
  });
}

export const ListCaseStudiesInput = z.object({
  kind: z.enum(schema.caseStudyKindEnum.enumValues).optional(),
  status: z.enum(schema.caseStudyStatusEnum.enumValues).optional(),
  clientId: z.string().uuid().optional(),
  featured: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type ListCaseStudiesInput = z.input<typeof ListCaseStudiesInput>;

/**
 * In page order — `sort`, then age. The public Work and Products pages, the
 * admin list and the home page grid are all this one query with a filter.
 */
export async function listCaseStudies(db: Db, organisationId: string, input: ListCaseStudiesInput = {}): Promise<CaseStudyRow[]> {
  const v = ListCaseStudiesInput.parse(input);
  return db.select().from(schema.caseStudies)
    .where(and(
      eq(schema.caseStudies.organisationId, organisationId),
      isNull(schema.caseStudies.deletedAt),
      v.kind ? eq(schema.caseStudies.kind, v.kind) : undefined,
      v.status ? eq(schema.caseStudies.status, v.status) : undefined,
      v.clientId ? eq(schema.caseStudies.clientId, v.clientId) : undefined,
      v.featured === undefined ? undefined : eq(schema.caseStudies.featured, v.featured),
    ))
    .orderBy(asc(schema.caseStudies.sort), asc(schema.caseStudies.createdAt), asc(schema.caseStudies.id))
    .limit(v.limit);
}

export const ReorderCaseStudiesInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
});
export type ReorderCaseStudiesInput = z.input<typeof ReorderCaseStudiesInput>;

/**
 * Takes the ids in the order Shoji dragged them and writes that order.
 *
 * Ids that are not this organisation's are dropped by the `where`, not
 * refused: a drag that raced a delete should still save the eight cards that
 * are still there. Anything not named keeps its `sort` and therefore ends up
 * after the named ones, which is what a partial reorder should do.
 */
export async function reorderCaseStudies(db: Db, organisationId: string, input: ReorderCaseStudiesInput): Promise<CaseStudyRow[]> {
  const v = ReorderCaseStudiesInput.parse(input);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const updated: CaseStudyRow[] = [];
    for (const [index, id] of v.ids.entries()) {
      const [row] = await tx.update(schema.caseStudies)
        .set({ sort: index, updatedAt: new Date() })
        .where(and(eq(schema.caseStudies.id, id), eq(schema.caseStudies.organisationId, organisationId)))
        .returning();
      if (row) updated.push(row);
    }
    if (updated.length > 0) {
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "case_study.reordered",
        targetType: CASE_STUDY_TARGET_TYPE, targetId: updated[0]!.id,
        after: { order: updated.map((row) => row.slug) },
      });
    }
    return updated;
  });
}

export const EnsureCaseStudyForProjectInput = z.object({
  projectId: z.string().uuid(),
  clientId: z.string().uuid(),
  name: z.string().trim().min(1).max(300),
  sector: CaseStudyFields.sector.default(""),
  summary: CaseStudyFields.summary.default(""),
  brief: CaseStudyFields.brief.optional(),
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type EnsureCaseStudyForProjectInput = z.input<typeof EnsureCaseStudyForProjectInput>;

/**
 * The draft story a new project starts with.
 *
 * Every build is a case study waiting to be written, and the cost of starting
 * one is a `draft` row nobody can see. Waiting until delivery instead means
 * the sector, the one-liner and the problem statement have to be reconstructed
 * months later from a proposal nobody has open — which is exactly how a
 * portfolio ends up three projects out of date.
 *
 * Idempotent by `case_studies_project`: the second caller gets the first
 * caller's row rather than a second draft.
 */
export async function ensureCaseStudyForProject(
  db: Db,
  organisationId: string,
  input: EnsureCaseStudyForProjectInput,
): Promise<CaseStudyRow> {
  const v = EnsureCaseStudyForProjectInput.parse(input);
  const existing = await getCaseStudyForProject(db, organisationId, v.projectId);
  if (existing) return existing;
  try {
    return await createCaseStudy(db, organisationId, {
      projectId: v.projectId,
      clientId: v.clientId,
      name: v.name,
      sector: v.sector,
      summary: v.summary,
      ...(v.brief ? { brief: v.brief } : {}),
      status: "draft",
      deliveryStatus: "in-build",
      actorKind: v.actorKind,
      ...(v.actorId ? { actorId: v.actorId } : {}),
      ...(v.now ? { now: v.now } : {}),
    });
  } catch (error) {
    const raced = await getCaseStudyForProject(db, organisationId, v.projectId);
    if (raced) return raced;
    throw error;
  }
}

export { CaseStudyRefused };
