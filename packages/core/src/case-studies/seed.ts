import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { PORTFOLIO, type CaseStudySeed } from "./portfolio.js";
import { ActorKindSchema, CASE_STUDY_TARGET_TYPE, type CaseStudyRow } from "./shared.js";

/**
 * Puts the existing portfolio into an organisation that does not have it yet.
 *
 * `0025_projects_case_studies.sql` runs the same insert in SQL, generated from
 * `PORTFOLIO`, so the live site keeps its Work and Products pages the moment
 * `work.ts` is deleted. This function is the same operation for an
 * organisation created *after* that migration — a fresh install, a test, and
 * the day this is sold to a second agency — and the reason the copy lives in
 * TypeScript rather than only in a migration file nobody will ever read again.
 *
 * **Idempotent by `(organisation_id, slug)`.** Running it twice inserts
 * nothing the second time; it does not update, either, because by then the
 * rows are the truth and this module is only the starting content. A story
 * Shoji has since rewritten must not be reverted by a re-seed.
 */

export const SeedCaseStudiesInput = z.object({
  /** What to write. Defaults to the whole portfolio; a test narrows it. */
  entries: z.array(z.custom<CaseStudySeed>()).optional(),
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type SeedCaseStudiesInput = z.input<typeof SeedCaseStudiesInput>;

export interface SeedCaseStudiesResult {
  /** The rows this call actually wrote, in portfolio order. */
  inserted: CaseStudyRow[];
  /** How many were already there and were left exactly as they were. */
  skipped: number;
}

export async function seedCaseStudies(
  db: Db,
  organisationId: string,
  input: SeedCaseStudiesInput = {},
): Promise<SeedCaseStudiesResult> {
  const v = SeedCaseStudiesInput.parse(input);
  const entries = v.entries ?? PORTFOLIO;
  if (entries.length === 0) return { inserted: [], skipped: 0 };
  const now = v.now ?? new Date();

  const inserted = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const rows = await tx.insert(schema.caseStudies)
      .values(entries.map((entry, index) => ({
        organisationId,
        slug: entry.slug,
        name: entry.name,
        clientName: entry.clientName,
        sector: entry.sector,
        summary: entry.summary,
        brief: entry.brief,
        stack: [...entry.stack],
        year: entry.year,
        url: entry.url,
        screenshots: entry.screenshots,
        featured: entry.featured,
        kind: entry.kind,
        // Everything seeded is already on the live site. Anything else would
        // mean deleting `work.ts` blanked the Work page until Shoji clicked
        // twenty Publish buttons.
        status: "published" as const,
        deliveryStatus: entry.deliveryStatus,
        charity: entry.charity,
        poweredBy: entry.poweredBy,
        domain: entry.domain,
        tagline: entry.tagline,
        description: entry.description,
        facts: [...entry.facts],
        sort: index,
        publishedAt: now,
      })))
      .onConflictDoNothing({ target: [schema.caseStudies.organisationId, schema.caseStudies.slug] })
      .returning();

    for (const row of rows) {
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "case_study.seeded",
        targetType: CASE_STUDY_TARGET_TYPE, targetId: row.id, after: row,
      });
    }
    return rows;
  });

  return { inserted, skipped: entries.length - inserted.length };
}
